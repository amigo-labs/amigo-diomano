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
2. **Material-weighted Laplacian**, one pass: rock 0.15, soil 0.40, sand 0.60,
   ash 0.55. Rock stays crisp and cliff-like; sand reads as dunes. The material
   map thereby drives silhouette, not just colour.
3. **Chunk skirts** — an outer ring pushed slightly inward.
4. **Seam vertices come from ghost-border data**, so face boundaries are
   continuous with no special case.

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

That is up from 0.60 ms, and the increase bought two things: the corner grid the
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

- **Right or middle drag orbits, until a spiral arms gesture mode.** `verbs.md`
  always said "middle or right drag *(no spiral)* | orbit the planet"; nothing
  implemented the qualifier, so both the camera and the recogniser consumed the
  same stroke — every gesture spun the planet underneath a path being matched in
  *screen* space. The recogniser now publishes an armed flag and the camera drops
  the stroke when it goes up.
- **Drag sensitivity scales with distance.** A fixed radians-per-pixel rate moves
  far more ground per pixel up close; the planet tore past at 1.35 R and crawled
  at 4.2 R.
- **The wheel is normalised by `deltaMode`.** `deltaY` is only pixels under
  `DOM_DELTA_PIXEL`. Firefox defaults to lines and reports about 3 per notch, so
  treating it as pixels made one notch a 0.4% zoom — zoom was effectively dead
  there and fine in Chrome, which is the worst way for a bug like this to sit.
- **Zoom goes to the pointer**, not to the centre of the screen. On a globe,
  zooming to the middle means every approach starts with a chase.

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
against a `[START]` ceiling of 150. Plus three post passes.

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
