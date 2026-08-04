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

The remaining drop is 0.0008 radii — a small fraction of a cell. Adjacent chunks
already share bit-identical border vertices and `Mesh::update` dirties both
sides of a changed border in the same call, so no crack window exists today. The
skirt is kept because that guarantee disappears the moment meshing is spread
across frames.

### Dirty tracking

Each chunk carries a content hash over its cells **plus a one-cell apron**,
because a chunk's border vertices average cells belonging to its neighbour.
`Mesh::update` re-meshes only chunks whose hash changed and publishes a per-chunk
`dirty` byte, which the TypeScript side uses to set `needsUpdate` on exactly
those attributes. `mesh::only_dirty_chunks_are_remeshed` asserts both the count
and which chunk.

Measured: **16.1 chunks re-meshed per tick** during the scripted perf session,
at 0.60 ms — charged to the render budget, not the 12 ms simulation budget.

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
atmosphere shell at 1.09 radii.

## Effect tiers

**Tier 1 — always on.** Implemented.

- Atmosphere: a slightly larger back-face sphere with a Fresnel rim. Highest
  impact per line in the whole list, and it is also where the tide telegraph
  lives (see below).
- Water depth absorption (Beer–Lambert): shallow teal → deep blue, exponential
  and per-channel, which is the whole reason shallow water is teal.
- Wet-sand band at the waterline, keyed off altitude relative to the *current*
  sea level, so it migrates during play.
- Slope- and height-based texturing: steep → rock, flat → grass, high → snow.
  Avoids UV-mapping a quadsphere entirely.
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
