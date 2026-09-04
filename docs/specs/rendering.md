# Rendering

Split from `docs/HANDOFF.md` §7 (Phase 0). Implemented by
`crates/diomano-sim/src/mesh.rs` and `web/src/renderer/*.ts`.

---

## Sim grid is not the render mesh

The simulation is discrete integer. The mesh is a smoothed interpolation of the
height field, chunked at 16×16 cells (96 chunks at N = 64), with only dirty
chunks re-meshed. Without smoothing the result is Minecraft terracing, not
Black & White 2.

The four smoothing steps, in order:

1. **Dual grid** — a vertex is the mean of the four cells around it, putting
   vertices at cell corners and halving terracing immediately.
2. **Material-weighted Laplacian**, two passes: rock 0.15, soil 0.40, sand 0.60,
   ash 0.55, and then the same weights at half strength. Rock stays crisp and
   cliff-like; sand reads as dunes. The material map thereby drives silhouette,
   not just colour.
3. **Chunk skirts** — an outer ring pushed slightly inward.
4. **Seam vertices come from ghost-border data**, so face boundaries are
   continuous with no special case.

### The second pass, and why it is a pass and not bigger weights

§7.1 specifies one pass, and one pass leaves a terrace step reading as a step:
the dual grid halves it and the Laplacian takes a fraction off what is left, so
a hand-dug edge is still a stair. A second pass at half weight takes the corner
off without flattening anything — rock goes from an effective 0.15 to about 0.22
— so §7.1's deliberate contrast, cliffs crisp against dunes soft, survives it.

Doubling the *weights* instead would have dissolved exactly that contrast, which
is the whole reason this is a second pass. And it needs a double buffer
(`smooth_pass1`): a Laplacian run in place reads cells its own pass has already
written, so the result would depend on iteration order — the same class of bug
the checkerboard passes in `water.rs` exist to avoid.

The ghost ring is refreshed **between** the passes, for the same reason it is
refreshed between checkerboard halves. Without it the second pass reads a stale
border, and two faces sharing a corner stop averaging the same four numbers — so
`face_boundary_vertices_coincide_exactly` and its colour twin would quietly stop
holding.

### Why the Laplacian runs in cell space

A vertex-space Laplacian at a chunk border needs corner data **two** cells
outside the face, and the ghost ring is one cell deep. In cell space it needs
one, which the ghost ring already provides — and the smoothed field is then
ghost-copied so vertices on a face boundary agree from both sides.

### Face boundaries are bit-identical, not merely close

A corner vertex on a face edge averages two live cells and two ghosts, and the
face on the other side averages **the same four cells**. Integer addition is
commutative, so both produce identical heights and there is no crack.

`mesh::face_boundary_vertices_coincide_exactly` asserts this over every corner
on every face, identifying corners by their exact position on the cube, with no
tolerance on either side of the comparison.
`the_eight_cube_corners_agree_across_all_three_faces` covers the ambiguous case.

**One real bug this found:** the tangent adjustment `tan(a·π/4)` was computed by
a Taylor series that returns 0.99997 at `a = ±1` instead of 1. Every face edge
therefore sat 3e-5 of a radius away from where its neighbour put it — a hairline
crack along all twelve cube edges, far too small to spot by looking and far too
large to leave in. `warp` now divides by `tan_series(π/4)`, so `warp(±1)` is
exactly `±1` and the series is exactly odd.

### Skirts are shallow, and terrain-only

Two corrections were needed:

- **Normals are computed before the skirt is sunk.** The skirt is a duplicate of
  the border vertex pushed inward, so dropping it first tilted every
  first-interior-ring normal — which drew a bright seam along every chunk border.
- **The water mesh gets no skirt.** Water is transparent and lit almost entirely
  by Fresnel, so a near-vertical skirt wall renders as a bright sky reflection
  and draws the chunk grid across the ocean in pale blue. There is nothing to
  hide there anyway: a crack in a transparent surface over opaque terrain is
  invisible.

**The drop is now zero, and the third correction is that the mechanism cannot
work here.** At 0.0008 radii the skirt was still being seen: both chunks either
side of a border drop their shared ring, the two dropped rings coincide, and the
pair forms a V-groove along every chunk boundary — 3% of a cell deep, and clearly
visible as a hairline grid every 16 cells across the planet. It was the most
conspicuous artefact left in the terrain, and it was mistaken for a chunk-seam
lighting bug until the drop was zeroed and the grid disappeared with it.

No value would have been right. To hide a crack from a stale neighbour the skirt
must be at least as deep as the height error it hides, and the smallest possible
error is one terrace — `16 x HEIGHT_TO_RADIUS = 0.00128`, already deeper than the
setting that was visible. "Shallow enough to be invisible" and "deep enough to
work" do not overlap.

What actually closes the window is `Mesh::update` dirtying both sides of a changed
border in the same call, which it does and which
`mesh::only_dirty_chunks_are_remeshed` pins. The ring is left in the buffer — the
outer quads degenerate to zero area — so the geometry is available if meshing is
ever spread across frames. Reviving it means a depth of at least one terrace and
accepting that it will be seen.

### The waterline is where the ground comes up through the sea

The sea used to be draped over the sea bed: each water vertex sat at the warped
terrain height plus the *unwarped* four-cell mean of `water`, and a 0/255 dry
flag per vertex told the shader where to stop drawing. The flag could only
change on the midlines of the vertex grid, so a coast running diagonally to the
cells was a staircase of one-cell steps — with the surf line and the sea-floor
tint sitting on every step. The domain warp bent the staircase; it could not
remove it.

Now the sea is what it is: a **flat surface at the level of the water standing
in the wet cells** (`mesh::corner_water` — `height + water`, which
`apply_sea_level` makes exactly `sea_level` in every ocean cell; a lake is its own
plane), and the land comes up through it. Where none of the four cells is wet the
surface runs on under the ground at sea level and the depth buffer hides it. The
depth attribute is that surface minus the terrain *as the terrain mesh draws it*
— smoothed and warped — and it is **signed**, four units per byte step: the
water shader interpolates it across the quad and ends the sea where it crosses
zero, which is exactly where the two smooth surfaces cross. The terrain shader's
absorption depth is floored by `-vAltitude`, the exact figure for the ocean.
`the_sea_surface_is_flat_over_the_ocean` and
`the_waterline_is_where_the_terrain_crosses_the_sea` pin both halves.

The alpha fade over the last terrace of depth stays, but it is no longer hiding a
polyline: shallow water is see-through, and a hard sheet of 92% alpha at the
beach would read as glass on sand.

### Chunk-border normals were discontinuous

Positions on a chunk border were proven bit-identical; normals were not, and
nothing checked them. `build_normals` differenced `positions`, whose outer ring is
the skirt — a duplicate of the border vertex — so a border vertex's central
difference collapsed to a one-sided one, and to a *differently*-sided one on each
side of the seam: a chunk's near border reads forward, its neighbour's far border
reads backward. Two copies of one vertex, two different normals.

Normals are now differenced from a scratch grid of true corner positions that
includes the ring one cell **outside** the chunk, so both sides difference the same
four positions in the same order and land on the same bits. It costs no extra
`corner_height` work: `positions` is filled from that grid rather than evaluated
separately.

The twelve cube edges keep one-sided differences. `corner_height` averages cells
`g - 1 ..= g` and the ghost ring is one cell deep, so the corner outside a face is
genuinely unavailable there; fixing it needs a two-deep ghost ring.
`mesh::normals_agree_across_chunk_borders` asserts the 1,224 shared vertices
inside faces, and was confirmed to fail against the old differencing before being
kept.

### Dirty tracking

Each chunk carries a content hash over its cells **plus a one-cell apron**,
because a chunk's border vertices average cells belonging to its neighbour.
`Mesh::update` re-meshes only chunks whose hash changed and publishes a per-chunk
`dirty` byte, which the TypeScript side uses to set `needsUpdate` on exactly
those attributes. `mesh::only_dirty_chunks_are_remeshed` asserts both the count
and which chunk.

Measured: **15.3 chunks re-meshed per tick** during the scripted perf session, at
**1.00 ms** — charged to the render budget, not the 12 ms simulation budget, so it
is 4.8% of the 21 ms the render half has.

**Re-measured** after the second smoothing pass, `attribs3` and the terrain
generator's shear and fine warp, and deliberately as a before/after on *one*
machine, because the figure above came from a different one and the two are not
comparable: 35.8 chunks/tick at 1.222 ms before, 43.3 chunks/tick at 1.478 ms
after — 7.0% of the render half.

The per-chunk cost is unchanged at 0.034 ms either side, so the extra grid pass
and the extra attribute are not what moved the total: **the chunk count did**.
That is a consequence of the generator change rather than of the mesher. More
relief means more water in motion means more chunks whose contents differ from
one tick to the next, and `chunk_content_hash` is doing exactly its job. Worth
knowing before anyone reads the +21% as a meshing regression and goes looking
for it in `build_chunk`.

**Re-measured again** after the domain warp and the third smoothing pass (see
`docs/specs/world.md`): **35.0 chunks/tick at 2.662 ms**, 12.7% of the render
half. This time the per-chunk cost *is* what moved — the chunk count went down
slightly — and it moved for a known reason: `corner_height` now samples the dual
grid bilinearly at a warped position, which is four evaluations of the four-cell
average where it used to be one, and there is a third smoothing pass over the
whole field on top.

That is the price of a world that does not look like it is made of cells, it is
paid once per changed chunk rather than per frame, and it leaves the render half
with 18 ms. The warp is a pure function of the cube point, so it *could* be
tabulated per corner — the note here used to say such a table would be 1.6 MB,
which was wrong by a factor of eight: 6 x 65 x 65 corners x two floats is
203 KB.

**Won back, 2026-09**, on one machine as a before/after over the same session:
**3.65 → 1.87 ms at 35.0 chunks/tick**. Four changes, every vertex
bit-identical (the seam tests compare bits and stayed green):

- The warp *is* now a 203 KB table (`Mesh::build_tables`), storing the very f32
  expressions `corner_height` evaluated inline, pinned by
  `warp_table_matches_the_direct_computation`. 3.65 → 2.03 ms alone.
- `chunk_content_hash` ran FNV-1a byte by byte over 31,000 cells a tick. It
  packs a cell into two words and folds each through a splitmix finaliser;
  `chunk_hash_sees_every_field_it_claims_to` checks each of the eight fields
  still moves it. `hash::Fnv64` is untouched — the fixtures depend on it.
- The second vertex pass recomputed `corner_direction` for a corner the first
  pass had just projected; it reads the slot.
- `smooth_heights` reads only height and material but ran three full passes
  plus three 105 KB copies on every update, tide ticks that moved nothing but
  water included. A fingerprint over its inputs — ghosts included, so the skip
  is exact — gates it, the passes ping-pong between the two buffers, and the
  perf harness prints how often it ran: **548 of 600 ticks** in the
  sculpting-heavy perf script. That is the honest number; the skip pays in
  quiet play, not there.

The client also calls `dio_mesh_update` once per **tick** now rather than per
frame (`game.ts`): the update is the smoothing and 96 chunk hashes even when
nothing changed, and at 60 Hz against a 30 Hz simulation every second call was
wasted, at 144 Hz four in five. The two uploads that read the dirty flags go
with it, because `Mesh::update` clears them as it starts.

Simulation, over the same session: **0.88 ms/tick, 7.4% of the 12 ms budget**,
against 1.47 ms before — see `docs/specs/simulation.md` for what changed. The
plate and erosion work is all in `init`, so it costs nothing per tick.

The first figure above is up from 0.60 ms, and that increase bought two things: the corner grid the
normal pass needs (a second evaluation of the dual-grid average per vertex, which
is what makes chunk-border normals agree) and the `attribs2` channel (lava,
fertility, sediment). Both are features rather than waste. Two candidate savings
were measured and rejected: reading the scalar height back from the corner grid
instead of recomputing it, and moving the per-chunk scratch off the stack into a
field. Neither moved the number — the cost is the two vertex passes themselves.

## The boundary

Meshing runs in Rust and writes vertex, normal and attribute buffers directly
into wasm memory. TypeScript wraps them in `THREE.BufferAttribute` views over
`memory.buffer` and only sets `needsUpdate`. Nothing is serialised.

One shared index buffer serves all 96 chunks: every chunk has identical topology,
so 96 copies of the same 1,944 indices would be 96 times the GPU memory for no
reason.

## Camera

Orbit on a spherical shell; panning rotates the planet. No map edges.

Distance is clamped to 1.35–4.2 radii. The far limit exists because §7.2 says
the horizon against space must always be visible: the curvature is the visual
identity, and a planet large enough to look flat wastes the entire architecture.

`HEIGHT_TO_RADIUS = 0.00008`, chosen against that constraint rather than for
realism — generated terrain spans about ±720 units, putting relief at roughly 6%
of the radius. Pronounced, clearly a sphere, and comfortably inside the
atmosphere shell.

### The horizon rule is unreachable with a nadir-locked camera

§7.2's "horizon against space always visible" and `MIN_DISTANCE` are in direct
conflict as long as the camera looks at the planet's centre, and the conflict is
arithmetic rather than a matter of taste. The planet's angular radius from
distance `d` is `asin(R / d)`, and the limb is inside a 45° frame only while that
is under the 22.5° half-angle — from `d ≥ 2.61 R`. At the 1.35 R floor the
angular radius is **47.8°**: the planet covers the whole frame and there is no
horizon in it anywhere. At the 2.3 R default it is 25.8°, so even the *default*
view had the globe cut off top and bottom.

Neither obvious fix works. Raising the floor to 2.61 R satisfies the letter of
the rule and makes close sculpting useless; widening the FOV enough to see the
limb from 1.35 R takes about 96°, which is a fisheye.

So the camera tilts. It looks at the planet's centre when pulled back and swings
toward the horizon as it comes in — `MAX_TILT = 0.42` rad at the close end,
scaled by `t²` so the far half of the range stays a clean overhead orbit. The FOV
widens from 45° to 56° over the same range, because 45° is narrower than the
planet's own angular radius down there and no amount of tilt fits both the ground
below and the limb above into a frame that narrow. At 1.35 R with 56° and 24° of
tilt the limb sits 4° inside the top edge and the sub-camera point 4° above the
bottom one: curvature on screen at every distance, close distance preserved.

Two further consequences of tilting:

- **`camera.up` is the local tangent, not world +Y.** With world +Y the `lookAt`
  basis degenerates as the view approaches a pole — which is what the `0.49π`
  pitch clamp was really guarding, and it still let the image roll near the
  limit. The tangent vector is perpendicular to the eye by construction, so the
  basis is well-conditioned at every pitch and the horizon stays level.
- **The near plane tracks the distance.** `0.01` against a far plane of `100`,
  for a scene that never comes nearer than about 0.29, threw away four orders of
  magnitude of depth precision.

### Controls

- **Right or middle drag orbits; a right *click* opens the power menu.** The
  qualifier this bullet used to carry ("until a spiral arms gesture mode") is
  gone with the recogniser it referred to: there is no gesture mode to arm, and
  the drag/click split is the same 5 px, 400 ms test the left button uses for the
  magnet.
- **The orbit is unbounded in both axes.** There used to be a 0.49pi pitch clamp,
  which meant that dragging north eventually just *stopped* — a globe you could
  not walk over the top of. What it was really guarding was the `lookAt` basis
  going degenerate at the pole, and `camera.up = northish` (built as
  `eye x east`, perpendicular to `eye` by construction) fixed that properly. Past
  the pole the horizon flips, and that is correct rather than broken: carrying on
  north over the pole leaves you facing south down the far side. Yaw had always
  been free to wind without bound; pitch now is too.

  A direction therefore has *two* orbit addresses — `(yaw, pitch)` and
  `(yaw + pi, pi - pitch)`, the same place from opposite headings — and `asin`
  only ever produces the first. `anglesFor` unwraps both toward where the camera
  already is and takes the nearer, or aiming at anything after a pole crossing
  would unwind a whole hemisphere to get back to the branch `asin` likes.
- **Drag sensitivity scales with distance.** A fixed radians-per-pixel rate moves
  far more ground per pixel up close; the planet tore past at 1.35 R and crawled
  at 4.2 R.
- **The wheel is normalised by `deltaMode`.** `deltaY` is only pixels under
  `DOM_DELTA_PIXEL`. Firefox defaults to lines and reports about 3 per notch, so
  treating it as pixels made one notch a 0.4% zoom — zoom was effectively dead
  there and fine in Chrome, which is the worst way for a bug like this to sit.
- **Zoom goes to the pointer**, not to the centre of the screen. On a globe,
  zooming to the middle means every approach starts with a chase.

- **The wheel does not zoom while the left button is down.** That drag is
  raise/lower, and a zoom in the middle of it — which also swings the orbit
  toward the pointer — moves the ground out from under the brush, so the stroke
  lands somewhere else. `camera.ts` remembers the left button from `pointerdown`
  and also honours the event's own button mask; the page still does not scroll,
  the wheel just waits for the release.

### Picking is refined against the surface

The hand's ray is intersected with the mean sphere and then re-intersected
against the surface radius at whatever cell that found, twice. One intersection
against the mean sphere is only correct at sea level: the error is
`height · tan(incidence)`, and with relief at 6% of the radius a mountain seen at
a glancing angle picked a cell several cells from the ground under the cursor.

The original reason for using the mean radius — that raising ground would
otherwise drag the cursor with it — survives: one terrace is 16 height units,
which is 0.05 of a cell, so the per-step feedback is far below a cell. Where the
pick does move over a long dig, it moves because the surface really did.

The pick is also recomputed every frame rather than only on `pointermove`.
Orbiting with the pointer held still used to leave the target on whichever cell
had been under it before the planet turned, and a click then acted on that stale
cell.

## One authority per shared value

`renderer/view.ts` owns the camera position, the sun direction, the cloud clock
and the render clock, and every material takes those uniform objects **by
reference**. That is not tidiness. Each of them had been declared per material,
and each drifted in a way that silently disabled a shipped feature:

- **`uCameraPosition` was declared in three shaders and written by none.** It
  stayed at the origin, so `viewDir` was the inward radial everywhere. The
  terrain's rim term evaluated to `pow(1 - 0, 4) = 1` over the *whole* planet
  instead of at the limb — a flat blue-grey wash on every pixel of ground, which
  is why the planet read as a featureless ball with no relief. Water Fresnel
  saturated the same way, replacing 70% of the Beer–Lambert gradient the shader
  exists for with flat sky colour. And the atmosphere shell's rim came out
  **exactly zero**, so the effect §7.3 calls "highest impact per line in the whole
  list" drew nothing at all — and with it the entire no-HUD tide telegraph, which
  only ever multiplies that rim. Verified by patching the uniform in a live page:
  the glow and the sunlit limb appear immediately.
- **Two suns.** `atmosphere.ts` rotated its own on the §7.2 day cycle while
  `planet.ts` and `water.ts` each built a private `Vector3(0.6, 0.5, 0.6)` that
  nothing ever moved. The terrain's terminator stood still while the clouds, the
  trees and the directional light turned.
- **`uCloudTime` was never written.** The ground sampled `dioClouds(up, 0.0)`
  while the shell scrolled — precisely the "shadows that do not line up with the
  clouds casting them" failure `CLOUD_NOISE_GLSL` is shared to prevent. Sharing
  the noise stopped the *pattern* from drifting; nobody had shared the clock.

Uniform objects are shared by reference in three, so holding them once makes the
drift unrepresentable rather than merely unlikely — the same argument that already
justified exporting `CLOUD_NOISE_GLSL` instead of copying it.

## Normals are world-space, and the sun is too

All three custom vertex shaders used `normalMatrix * normal`. Three builds
`normalMatrix` from the *modelView* matrix, so that is a **view-space** normal —
and every consumer is world-space: `uSunDirection`, `up = normalize(vWorld)`, the
slope→rock blend, the sky bounce. The day/night terminator and the
steep-reads-as-rock band therefore swung around as the camera orbited. The model
matrix is the identity here, so `mat3(modelMatrix) * normal` is both correct and
free.

## The planet was inside out

For phases 1–6 the globe rendered **see-through**: the near hemisphere was culled
and what you looked at was the *inner* surface of the far one.

`mesh.rs`'s `build_indices` emitted each quad as `a, c, b` / `b, c, d`, where `i`
steps along `FACE_RIGHT` and `j` along `FACE_UP`. That winding normal is
`up × right`, which is *inward* — and `seams.rs`'s `build_seam_table` asserts
`right × up == normal` in const eval, so this was exact rather than approximate:
all six cube faces came out clockwise seen from outside. Both globe materials use
three's default `side: FrontSide`, which culls back faces, so the ground under
the camera was thrown away and the back of the world drawn in its place. The
water inherited it, because `planet.ts` and `water.ts` share `sim.meshIndices`.

Three things kept it from looking like a broken mesh, which is why it survived
six phases and three rounds of fixes:

- **The silhouette is unchanged.** Near and far hemisphere project to the same
  disc, so nothing went missing at the edge — the depth was just ~2 R further
  back.
- **The normal attribute is forced outward** independently, in `build_normals`,
  so the far side's inner surface lit plausibly instead of inverting.
- **The limb gate went vacuous.** `planet.ts` keys its haze on
  `limb = 1 - smoothstep(0.12, 0.62, max(dot(up, viewDir), 0.0))`. On the far
  hemisphere `dot(up, viewDir) ≤ 0`, so `limb == 1` over the whole disc and the
  full sky-colour wash landed everywhere rather than at the rim. The invariant
  the tuning rested on — "the working ground sits at `dot(up, viewDir) >= 0.70`,
  so the gate holds it at zero haze by construction" — was true of a hemisphere
  that was never drawn.

Hence the recurring reports, each of which got answered at the wrong layer: a
concave surface shaded with outward normals has no curvature gradient, so the
planet "read as a disc"; the far side genuinely showed through, so it "read as a
glass marble". `9ca0798` cut water alpha and Fresnel, `db23295` moved the haze
gate, `f9df386` raised the limb wash 4.2× to put the curvature cues back. None
of them touched `side` or the index order, and each was tuning the compensation
rather than the cause.

Nothing tested orientation. `indices_are_a_valid_triangle_list` checked index
range and triangle count; `normals_are_unit_length_and_point_outward` pinned the
half that was already right. The missing check is now
`triangles_wind_outward_so_the_planet_is_not_inside_out`, which walks real meshed
geometry and asserts every non-degenerate triangle's `(v1-v0) × (v2-v0)` faces
along the centroid. It filters on the cross product rather than excluding index
ranges, because the skirt ring is an exact duplicate of the border corner while
`SKIRT_DROP` is zero and so has no orientation to check.

**The limb shell no longer paints the disc.** With the winding fixed, the
atmosphere shell's `offPlanet` feather was found to be double-counting: it added
the *whole* tangent column, scaled only by the feather, on top of ground that
`dioAerial` had already hazed by the same amount. It was widened to hide a step
at the silhouette, but `tau` is written to agree with the ground shaders at
`h = 0` by construction — which is why `dioColumn` is shared rather than copied —
so there was no step to hide. It also was not the "thin 3% wedge" it was
described as: `b` is an impact parameter, so a fixed band in `b` covers more and
more screen as the camera descends and the limb flattens, which is how it became
a bright band lying across the near sea. The feather now stops at the limb.

## Two more defects of the same kind

- **The hand's fill sphere was hidden by its own container.** `palm` is a
  transparent shell with `fill` strictly inside it and did not set
  `depthWrite: false`; three sorts two transparent meshes at one position by
  creation order, so the palm drew first, wrote front-face depth, and the fill
  failed the depth test outright. The one diegetic readout §4.2 asks for — how
  much matter am I holding — was invisible.
- **`vertexColors: true` with no `color` attribute** on the settlement and walker
  materials. It defines `USE_COLOR`, `color_vertex.glsl` runs `vColor *= color`
  against an unbound attribute, and `MeshLambertMaterial` — unlike
  `ShaderMaterial` — has no `defaultAttributeValues` to fall back on. `vColor`
  collapsed to zero: **settlements and walkers rendered black**, and the tier-2
  night-side settlement lights added nothing, because they add `vColor * warm`.
  `instanceColor` sets `USE_INSTANCING_COLOR` by itself and needs no help.

## Post chain order

`RenderPass → Bloom → OutputPass → FXAA`. FXAA thresholds on luma and needs sRGB
input; three's own `OutputPass` documents the requirement. It used to run *before*
`OutputPass`, evaluating linear-light data, which under-detects edges in shadow
and over-smooths highlights — on exactly the aliasing-instanced-trees content
§7.3 makes FXAA non-optional for. Two sizing bugs went with it:
`bloom.setSize(w, h)` undid the composer's DPR-aware sizing (half-res bloom on a
2x display), and the bootstrap call passed drawing-buffer pixels into a function
whose other caller passes CSS pixels, counting DPR twice.

## Effect tiers

**Tier 1 — always on.** Implemented.

- Atmosphere: a slightly larger back-face sphere with a Fresnel rim. Highest
  impact per line in the whole list, and it is also where the tide telegraph
  lives (see below).
- Water depth absorption (Beer–Lambert): coastal teal → deep navy, exponential
  and per-channel. The sea is a body, not a window: alpha starts at 0.92,
  Fresnel is a glint. The previous 0.42 / 0.7 pair let the far side show through.
- Beach at the waterline, keyed off altitude relative to the *current* sea
  level, so it migrates during play. Sand, not darkened grass: without a
  beach every island is a melted green sticker in a blue fill.
- Slope- and height-based texturing: steep → rock, flat → grass, high → snow.
  Avoids UV-mapping a quadsphere entirely.
- Fertile land is meadow from tick zero. Generation writes fertility and leaves
  vegetation at 0, so the grass read has to come from the potential, not from
  trees that have not grown yet. Grown vegetation then deepens it to canopy.
- Aerial haze is **limb-only**, keyed off `dot(up, viewDir)`. A full Chapman
  mix, even distance-gated, is sky-coloured across the sunlit disk, so overhead
  ground stayed unreadable. The horizon still blends into the sky ring.
- FXAA. Not optional: instanced trees on a sphere alias badly, and MSAA would
  cost more on integrated graphics for a worse result on exactly that content.
- Rim light on walkers. Functional: tiny figures must separate from any terrain.
- ACES tone mapping (via `OutputPass`) and subtle bloom.

**Tier 2 — medium.** Implemented, except the shadow map.

- Instanced vegetation, density from the `vegetation` field. ✅
- Water ripple: two procedural normal fields scrolling at different speeds and
  directions. ✅
- Sun glitter: high-exponent specular on the ocean. ✅
- Night side with emissive settlement lights. ✅ — and it is not decoration:
  with no HUD, the night hemisphere is otherwise the one place where you cannot
  read who holds what.
- Cloud shell with ground shadows. ✅ — the terrain shader samples the *same*
  noise function the cloud shell draws with, exported once as
  `CLOUD_NOISE_GLSL`. Two copies would drift, and the symptom would be shadows
  that do not line up with the clouds casting them: subtle enough to read as a
  lighting bug rather than a copy-paste one.
- Single sun shadow map. ❌ not implemented. The cloud shadows cover the large-
  scale case and terrain self-shadowing is the part that needs a shadow map;
  on the §7.6 reference floor that is the item most likely not to fit, so it is
  the right one to leave until it can be measured there.

**Tier 3 — high.** Out of scope for this run, as instructed.

### Draw calls

**7 at tier 2, measured** (terrain, water, cloud shell, atmosphere shell,
starfield, settlements, walkers; vegetation makes 8 once anything has grown),
against a `[START]` ceiling of 150. Plus three post passes. With the tier-2
models (see *Models* below) the flora is eight meshes and the buildings four, so
a grown planet draws **19**.

It was ~197 before, which is what the ceiling exists to catch. The fix is not
culling — on an archipelago map every 16×16 chunk touches ocean, so per-chunk
visibility saved exactly nothing. Chunks simply do not need to be separate
objects: Rust already writes every chunk's vertices into **one contiguous**
array, so a single `BufferAttribute` spans all 96 and one index buffer with a
per-chunk base offset draws them in a single call.

Dirty-chunk updates survive intact. Each rebuilt chunk contributes an
`addUpdateRange`, so a changed chunk uploads its own few kilobytes rather than
the whole 400 KB buffer.

The water geometry goes further and uses `Mesh::water_present` to build its
index buffer over **wet chunks only**, rebuilt when the wet set changes. On a
land-heavy map that removes most of the ocean's triangles before rasterising,
rather than relying on the fragment shader to discard them afterwards.

## Models

Everything that stands on the planet is built in `renderer/models.ts` from
three's primitives and `mergeGeometries`; nothing is downloaded (§7.5). Two
tiers, chosen once at start-up like the effects (§7.3):

- **Tier 1** is the set the game shipped with — a cone is a conifer, a box is a
  house, the population is the 204-triangle `villager-low.glb` — because the
  §7.6 floor is integrated graphics and a forest is up to 8,700 instances. They
  are unchanged, byte for byte where a file is involved.
- **Tier 2** is the same silhouettes with their parts: conifers with a trunk and
  stacked tiers (~40 Δ), broadleaves with a root flare, branches and a lobed
  crown (~170 Δ), palms whose trunk curves and carries fronds and coconuts
  (~100 Δ), scrub in lumps (40 Δ); a hut under thatch, a house with a pitched
  roof, door and chimney, an eight-sided keep with merlons, and a wall around a
  citadel; a crystal for pickups, an obelisk for the magnet; and a 464-triangle
  villager with a jaw, shoulders, a belt and boots from the same generator
  (`scripts/build-figure.mjs`, which writes both files). Fingers with knuckles
  and nails on the hand at either tier — it is two meshes.

Each model carries its triangle budget in its comment. A fully grown planet at
every cap is around **0.6 M triangles at tier 2**, which integrated graphics
rasterises comfortably and which tier 1 never pays.

**Colour is a vertex attribute.** An `InstancedMesh` has one material and so
one colour, which is why every broadleaf used to be green from the ground up.
Tier-2 parts carry a `color` attribute, `mergeGeometries` carries it through,
and `hazedLambert` turns on `vertexColors` only for geometry that has it — the
note in `vegetation.ts` about black settlements is about the case *without* the
attribute, where three's generic value is zero. With it, `vColor` is the
part's colour times the instance tint: brown trunks, terracotta roofs and the
species' green in one draw call.

**Variants.** A forest of one model is a forest of clones however it is
jittered. Each species has two geometries, one instanced mesh each, chosen per
cell by hash so a stand is a mix and a reload grows the same mix. Buildings are
four meshes (hut, house, tower, wall) chosen by the settlement's tier and the
block's place in the cluster. Draw calls at tier 2: 7 as before, plus 8 flora
and 4 building meshes — 19, against the ceiling of 150.

`web/tools/gallery/` lays every model of both tiers out under the game's light,
for looking at a change without growing a forest first.

## Audio

Still all synthesis (§7.5); `web/src/audio/` is four files.

- **The chain** (`synth.ts`): master → limiter → destination, plus a room — a
  `ConvolverNode` whose impulse is *generated*, decaying noise darkening as it
  goes, different in each ear. Layered voices add up, and clipping is the one
  failure a procedural mix cannot be forgiven, so the limiter is not optional.
- **`voice`** is the one shaped source every one-shot is a call to: oscillator
  and/or noise, envelope, filter sweep, room send, and optionally a *cell*. A
  voice with a cell is panned by where the cell sits in the camera's view and
  quietened as it leaves the frame or crosses to the far side of the planet.
  The opponent's volcano is heard over there; the earthquake under the hand is
  heard here. Each verb has its own layered voice (a bell with its partials for
  the magnet, sub + rumble + hiss for the volcano, a swell for the flood, …).
- **The beds** (`ambience.ts`) follow the simulation *under the camera*. The
  view ray is cast onto the planet once a tick and a 9 x 9 window at stride four
  is read around the hit: forest where vegetation stands (with a slow swell),
  lava crackle where lava lies, surf from the local erosion marker with the
  planet-wide figure kept as a floor so a tide is still heard from orbit, and
  wind that rises as the camera pulls out and before a wave lands. The grind of
  ground being worked retunes to the material under the brush and to what the
  hand carries.
- **The population** (`events.ts`) had no sound at all. The census counters —
  write-only from the simulation's side, still so — are exported as
  `dio_census_combat` / `dio_census_merges` and diffed tick to tick; a rise is a
  clash, placed at the first cell holding walkers of both gods and rate-limited
  to six a second. Settlement slots are diffed for founding, tier rises (a bell
  per tier) and falls, placed at the settlement and quieter for the other god's.

Nothing here feeds back: the noise PRNG is a local LCG, the census is read and
never written, and the camera is the only input the simulation does not have
(§10).

## Lava, and the other two fields §7.4 asked for

`attribs` was full — material, vegetation, influence, water depth — so §7.4's
"write them as vertex attributes" was only three-fifths done. `attribs2` carries
**lava, fertility and sediment**.

Lava is the one that mattered. `sim.lava` was mapped into JavaScript and read by
no renderer file, so §5.3's volcano produced no hot lava anywhere: the only sign
one had gone off was ash-coloured ground *after* the flow had already cooled. It
is now drawn emissively — written over the shaded result rather than multiplied by
the sun, because lava is the light source — on a depth-keyed ramp from dark crust
to a yellow-white core, with the core deliberately above the bloom threshold so a
flow glows into the air around it.

Two details that are easy to get wrong:

- **Lava is the maximum of the four cells at a corner, not the mean.** The other
  fields are ground properties and take the cell's own value; lava is a fluid
  front, and averaging it fades the edge out over a cell and a half when the thing
  a player needs to read is where the front *is*.
- **Everything in the vertex buffers has to be in `chunk_content_hash`.** Lava was
  the field that made this load-bearing: it moves every tick over ground that does
  not, so a chunk whose height and material were unchanged would never have been
  re-meshed and the attribute would have gone stale immediately.
  `mesh::lava_reaches_the_vertex_buffer_and_dirties_its_chunk` asserts the flow in
  both directions, including that a cooled flow stops glowing.

## A material id is not a vertex attribute

The world reads as a grid, and this was the largest single reason.

`attribs[0]` carried the **material id** of one cell, and the GPU interpolates
vertex attributes linearly across a quad. Between a rock cell (0) and a soil cell
(2) the interpolated value therefore passes through 1 — which is *sand* — and the
fragment shader thresholded it with `step`. Every rock/soil boundary on the planet
grew a one-cell sand stripe with two hard edges, aligned to the cell grid, in both
the palette and the texture selection. An id is a label; interpolating labels
produces the labels in between.

`attribs3` carries **weights** instead: how much of the four cells behind a vertex
is rock, sand, soil and ash, with swamp as `255 - sum`. Weights are quantities, so
interpolation means what it says — a vertex where two of four cells are rock
genuinely is half rock, and halfway to a pure-soil vertex is a real mixture rather
than an invented third material. The shader blends the five palettes by these and
thresholds nothing.

### The weights are noise-sharpened, not merely blended

A plain weighted sum is correct and still wrong to look at: it fades linearly over
exactly one cell, which reads as an airbrushed grid rather than as ground. Each
weight is therefore offset by its own band of the 3D noise the rest of the shader
already uses and then raised to a power (`SPLAT_SPREAD` 0.42, `SPLAT_SHARP` 3.0).
The boundary becomes an interlocking fringe that follows the noise field instead
of the cell grid — which was the point, since the grid was the complaint.

The fallback matters: if every weight is pushed below zero at once the shader
returns the unsharpened mixture. A fragment with no material sums to black, and
black holes in the ground would be a worse artefact than a soft edge.

### The four cells must be the same four from both sides of a seam

`corner_material_weights` reads `idx_i` with the coordinate clamped to `-1 ..= N`
— the ghost ring — exactly as `corner_height` and `corner_water` do, and
deliberately **not** `clamp_cell`, which clamps to `0 ..= N - 1` and so reads a
different cell at a face edge depending on which face is asking. Integer addition
being commutative, both faces then land on identical bytes and a shared corner
cannot show as a colour discontinuity along the twelve cube edges. The eight cube
corners take the same escape hatch as height: the ambiguous diagonal ghost (§3.5)
is skipped and the three real cells that meet there are counted instead.

`mesh::material_weights_agree_across_a_face_boundary` asserts it over every shared
corner with no tolerance, and
`mesh::material_weights_are_a_partition_of_the_four_cells` pins the sum, because
the shader derives swamp from it: a sum over 255 makes swamp negative, and a sum
that never reaches 255 tints every cell with a material that is not there. Both
are silent in the picture.

## Verb effects

Flood, volcano, swamp, earthquake and armageddon had no visual of any kind — the
only feedback was a procedural audio one-shot and, on the next re-mesh, terrain
that had quietly changed. With no HUD (§8) a power that landed off screen was
indistinguishable from one that never fired.

Effects are driven from a **verb-event ring** in `world.rs`, written at the same
point and past the same gating as the census's per-verb counts. Two properties
follow, and both are the reason it is done there rather than at the click:

- a power refused on cost or availability throws no sparks, so the picture cannot
  claim something the simulation declined to do;
- the **opponent's** casts are visible, which a click-driven system could not
  manage — a client sees its own commands and never theirs.

The ring is instrumentation, excluded from the state hash and covered by
`world::the_census_is_not_hashed`, so a cosmetic cannot desync a match. The
renderer keeps a high-water mark and reads forward, so it is free to lag; falling
more than a ring behind drops the oldest, which for a cosmetic is the right
failure.

All particles for all effects are instances of one octahedron in a single
`InstancedMesh` with per-instance colour, integrated on the CPU. Two things had to
be right for them to read as anything:

- **A burst starts spread across the brush radius.** Spawning every particle on
  one point and letting velocity separate them meant forty additive sprites
  overlapped for the first few frames, saturating to a flat white blob — and it
  was wrong anyway, since earthquake and flood act over an area.
- **Per-particle colour is a fraction of the intended brightness.** Under additive
  blending what the player sees is roughly the colour times the overlap count, so
  palettes written at display strength all summed to white and every effect looked
  identical.

Earthquake and armageddon also shake the camera, applied to the eye rather than to
the target so the horizon stays level: a rolling camera reads as a broken control,
a jittering one reads as the ground moving.

## Terrain that remembers

`material`, `vegetation` and `influence` are written as vertex attributes and
the shader blends colour from them. A valley that was flooded stays darker; where
lava ran, rock remains. Visual richness falls out of simulation data rather than
authored art.

`influence` blends between two colour moods, one per god, so the boundary between
the zones is the most visually interesting region of the planet — which is also
where the war happens. That is what makes "no HUD" survivable: the planet is the
scoreboard.

## Assets

Everything is procedural: shaders, geometry, audio, starfield. No purchased
textures, no third-party models, no licensing exposure.

Measured payload: **197 KB wasm (34 KB gzipped)**, 487 KB Three.js (122 KB
gzipped), 60 KB app (19 KB gzipped). Total ≈ **175 KB compressed**, against a
≤ 3 MB budget.

## Target hardware

Desktop browser only. Reference floor: an office PC with Intel UHD 630 / Iris Xe
class integrated graphics, 4 cores, WebGL2.

> **The 30 fps claim of §7.6 is NOT verified by this run.** This environment has
> no GPU to throttle and no second weak machine. The renderer has been verified
> to *work* — headless Chromium on SwiftShader, a software rasteriser — but a
> frame rate from software rendering is not a frame rate from integrated
> graphics, and quoting one would be worse than quoting none.
>
> Mark the number unverified until `just preview` has been run on the real
> target.
