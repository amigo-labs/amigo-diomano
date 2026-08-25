# World model — cubed sphere

Split from `docs/HANDOFF.md` §3 (Phase 0). The HANDOFF remains the design
document and wins any disagreement about *intent*; these files carry the
implementation contract and the values that have since been measured.

Implemented by `crates/diomano-sim/src/{world,seams}.rs`.

---

## Why not an icosphere

A geodesic sphere has 12 pentagonal cells, breaking the uniform neighbour count.
More decisively, the core verb is shaping flat contiguous **square** plateaus
with square build sites; a hex grid works against that mechanic. A cubed sphere
keeps square cells and integer indexing.

## Topology

Six square integer grids, one per cube face, projected onto the sphere at render
time. **The sphere exists only in the renderer.** The simulation operates on six
2D integer arrays and knows nothing about a sphere.

```
Face indices: 0 = +x, 1 = -x, 2 = +y, 3 = -y, 4 = +z, 5 = -z
N = 64                       // cells per face edge — see "Choosing N" below
S = N + 2                    // stride, includes 1-cell ghost border
index(face, x, y) = (face * S + (y + 1)) * S + (x + 1)
```

Live cells at N = 64: `6 * 64 * 64 = 24,576`. Addressable cells including the
ghost ring: `6 * 66 * 66 = 26,136`.

### Choosing N

`N` is a **compile-time** constant, not a runtime one. The simulation crate is
`no_std` with no allocation inside a tick, so every field is a fixed-size array.
A map manifest that asks for a different `n` is **rejected with an error** by
`powers::parse_manifest` rather than silently ignored — generating a world of
the wrong size and desyncing thirty seconds later is a much worse outcome than
a parse failure.

This is a deviation from HANDOFF §5.4, which implies `n` is per-map data. See
`docs/specs/determinism.md` for the trade.

**Measured, 2026-08:** see `docs/specs/simulation.md` for the per-pass numbers.
Simulation cost at N = 64 is **1.51 ms/tick** on the development machine against
a 12 ms budget — 12.6% of budget, 7.9x headroom. Cost is close to linear in cell
count, so that headroom would nominally support N up to ~176.

**N stays at 64.** The measurement was taken on a development container, not on
the §7.6 reference floor (an office machine with Intel UHD 630 / Iris Xe class
integrated graphics). Every budget in the HANDOFF is stated against that floor,
and 7.9x headroom on a strong machine is not 7.9x headroom on a weak one — a 4x
slower CPU puts N = 64 at half the budget and N = 96 over it. Raising N would
also multiply the render cost, which is the tighter constraint on integrated
graphics, not the looser one.

The `[START]` guess and the measured choice coincide. That is a result, not an
absence of one, and the number that changed is the recorded cost.

> **Unverified:** the reference-floor figure. This environment cannot throttle a
> GPU or provide a second weak machine, so the 30 fps claim of §7.6 is **not
> verified** by this run. Treat 1.51 ms/tick as an upper bound measured on
> strong hardware and re-run `just perf` on the real target before trusting it.

## Seam table

A cube has 12 edges, each traversable from two sides: **24 seam rules**.

```rust
struct SeamRule {
    face: u8,       // destination face
    axis: Axis,     // which destination axis the source edge coordinate maps to
    flip: bool,     // is that coordinate reversed
    at_max: bool,   // enter at index 0 or N-1 on the other axis
    dir: u8,        // heading, re-expressed in the destination frame
}
const SEAM: [SeamRule; 24] = /* face * 4 + edge; edge order N, E, S, W */;
```

The table is **derived at compile time** from the six face bases
(`FACE_NORMAL` / `FACE_RIGHT` / `FACE_UP`), not typed by hand. Hand-writing 24
rules is the classic way to ship a cubed sphere with three subtly wrong entries
that surface as a rendering artefact six weeks later.

### Direction rotates across a seam

The `dir` field is not in the HANDOFF struct. It is fully determined by the
other four, and materialising it records something the spec states in prose:

> leaving the east edge of `+x` you enter `+y`, where the direction you called
> "east" is now "south"

Leaving the east edge of `+x` you enter `-z` still heading east. Leaving the
**north** edge of `+x` you enter `+y` heading **west**. There is no assignment of
face coordinate systems that avoids this; it is a property of the cube.

Consequences, all load-bearing:

- `seams::step` returns `(face, x, y, dir')` — a cell *and* a heading.
- The involutivity law is `step(step(c, d) → (c', d'), opposite(d')) == (c, opposite(d))`.
  Using `opposite(d)` for the return step is wrong and fails on half the seams.
- The flow field stores, at each cell, the heading that walks back toward the
  target *in that cell's own frame* (`flowfield::rebuild`).
- Walkers carry the sub-cell offset through the transform (`walkers::cross_seam`),
  so they do not visibly jump when they change face.

### Required tests

Both live in `seams::tests` and both must pass before anything downstream is
trusted, because a seam bug presents as a rendering bug:

- `closed_loop_all_24_entry_points` — for all 6 faces x 4 directions x 64
  offsets, walk `4 * N` steps and assert the loop closes on the same cell and
  the same heading, having crossed exactly four faces.
- `neighbour_is_involutive` — for every cell and direction, step out and back.

## Ghost borders

Before each simulation tick, copy the boundary rows and columns of neighbouring
faces into each face's ghost border: 6 faces x 4 edges x N cells, flattened into
one gather over precomputed `GHOST_SRC` / `GHOST_DST` tables. Every CA pass then
iterates `0..N` on a plain borderless grid with zero seam checks in the hot loop.

The ghost ring is refreshed **between the two halves** of every checkerboard
pass. That is what makes matter conservation exact across a seam; see
`docs/specs/simulation.md`.

## Cube corners

Each of the 8 cube corners is shared by 3 faces, so the diagonal ghost cell at a
face corner is ambiguous.

**Resolution: all cellular-automata rules use the von Neumann (4-neighbour)
neighbourhood only.** Diagonals are never read, so the ambiguity cannot be
observed. Hard rule — do not add a diagonal-reading rule without re-solving
corners.

Two places read a diagonal and both handle it explicitly:

- `settlements::detect_plateaus` uses the up-left diagonal for its O(1)
  dynamic program, so it never touches the ghost ring at all and runs strictly
  inside each face. Cost: a plateau straddling a face boundary is not detected
  as one.
- `mesh::corner_height` special-cases the 8 cube corners, averaging the three
  real cells that meet there — a set all three faces agree on.

## Units

```
1 visible terrain terrace = 16 internal height units   (TERRACE)
height, water, lava are all in the same units and directly comparable
i16 range +/-32767 = +/-2048 terraces
```

`height + water` is a valid water-surface altitude with no scaling. Terrain is
clamped to `HEIGHT_MIN = -8192 .. HEIGHT_MAX = 8192`, leaving headroom for the
tide and the flood power to move sea level without saturating anything.

## State layout

All simulation state is integer, in flat typed arrays owned by Rust.

| Field | Type | Meaning |
|---|---|---|
| `height` | `i16` | terrain altitude in units |
| `water` | `i16` | water depth above terrain, 0 = dry |
| `lava` | `u8` | molten depth, 0 = none |
| `material` | `u8` | rock 0 / sand 1 / soil 2 / ash 3 / swamp 4 |
| `fertility` | `u8` | soil potential, 0–255 |
| `vegetation` | `u8` | actual plant density. **Simulation state, not a shader input** |
| `sediment` | `u8` | eroded material in transit / deposited |
| `influence` | `i8` | −127..127, signed territory ownership |
| `dry_ticks` | `u16` | consecutive ticks with neither water nor vegetation |

`fertility` and `vegetation` are deliberately separate. Fertility is potential;
vegetation is what actually grew and has mechanical effects. Vegetation can be
destroyed without destroying fertility, which is what makes regrowth a recovery
mechanic rather than a permanent loss.

Derived per-tick scratch — not hashed, rebuilt every tick: `erode`,
`water_near`, `plateau`, `settle_of`, `flow`, `dist`, `queue`, `infl_acc`,
`cell_count`, `cell_start`, `bucket`, `seam_flux`.

`World` is a plain-old-data type: every field is an integer or an array of
integers. `determinism::the_world_is_a_plain_old_data_type` asserts it, because
`World::boxed()` hands back `alloc_zeroed` memory and calls it a `World`, which
is only sound while that holds.

## Terrain generation

Seamless by construction: the noise is sampled at the cell's position **on the
cube, in 3D**. Adjacent cells across a face boundary are adjacent in 3D too, so
no per-face fixup exists to get wrong. Five octaves of integer value noise with
trilinear interpolation and integer smoothstep; no floats anywhere.

The stack has some shape to it, all of it there because the plain four-octave
average produced walls and blobs:

- **Per-octave offsets and axis swizzles.** With aligned lattices, every
  cube-face plane sat exactly on a lattice plane of every octave, and the
  smoothstep's zero derivative there drew straight, flat bands — and straight
  coastlines — along all twelve cube edges. Each octave now samples at its own
  odd offset and axis permutation; both are exact integer isometries, so seam
  continuity is untouched.
- **Per-octave shear**, because isometries are not enough. Every isometry of the
  cubic lattice maps axis planes onto axis planes, so the swizzles stop the
  octaves' flats from stacking on each other — which is what they are for — and
  leave every lattice parallel to the cube's axes. At shift 8 that lattice is
  two cells wide, so the grid it draws lands exactly at the scale a player looks
  at from close range, and the world reads as rasterised. Each octave is
  therefore also sampled through a shear (a coordinate offset by `>> 1` or
  `>> 2` of another axis), tilting its planes 15 to 27 degrees off the axes.
  Safe for the same reason as everything else here: a function of the 3D cube
  point alone. `>>` is floor division for negatives, so the shear is continuous
  through the origin, and its one-unit staircase is ~0.13 height units against a
  16-unit terrace — three orders of magnitude below visible.
- **Re-weighted octaves.** The old dominant octave's lattice spacing was the
  whole cube half-extent (~2 cells per axis over the entire planet), which made
  every map two smoothstep blobs per face. It is demoted to a continental
  tilt; the half-spacing octave leads, and a new fine octave adds the texture
  the old stack lacked.
- **One ridged octave** (`ridge(n) = 65535 - |2n - 65535|`): connected
  mountain chains instead of round bumps.
- **Domain warp at two scales** (amplitude 600 against the shift-11 spacing of
  2048, and 140 against the shift-9 spacing of 512 — both ~0.28 of their own
  lattice): value noise has square isolines; sampling the height through a warp
  of the cube point bends them into natural curves. Both warp fields are
  continuous functions of the 3D cube point, so neither can introduce a seam,
  and that argument does not care how many octaves of warp there are.

  The coarse warp was alone here, and one warp cannot do this job: a shift-11
  field is constant over 16 cells, so it *translates* the fine octaves rather
  than bending them. Their own lattices stayed axis-aligned at cell scale, which
  is the other half of the same rasterised look the shear above addresses.
- **Midrange widening** (`widen(h) = smooth((h - 16384) * 2)`): the weighted
  octave average clusters around the midpoint, so the nominal ±720 amplitude
  was almost never reached and the rock threshold (380) and the renderer's
  snowline never fired. The smoothstep remap triples the slope at the midpoint
  and saturates smoothly.
- **Bias as a sea-level shift, not a subtraction.** Each terrain profile's bias
  moves where the sea sits in the distribution, then both sides are stretched
  back to the full ±720 span — subtracting it outright also lowered every peak,
  which is how the wetter profiles lost their mountains. Biases are measured
  against the widened distribution (archipelago 350, pangaea -40, volcano 210)
  and pinned by `world::tests::terrain_profiles_produce_playable_land`:
  land fraction per profile, rock cells, real peaks, real ocean floor, across
  four seeds each.

**Measured after the shear and the fine warp landed**, over the test's four
seeds: archipelago 26–43% land, pangaea 56–79%, volcano 37–58%; peaks 720–816,
ocean floor at the -720 clamp throughout. The distribution barely moved — the
changes rotate and bend the field, they do not rescale it — so no bias needed
retuning, which is the result rather than the absence of one.

`world::tests::terrain_is_continuous_across_every_seam` asserts that the mean
height step across a seam is within 3x the mean step inside a face.
