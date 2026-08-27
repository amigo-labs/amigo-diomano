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

**Geology, not a noise field** (user decision, superseding §3.3's `[START]`).
`tectonics.rs` assembles the height field from the three processes that make a
planet, and the noise that used to *be* the terrain is demoted to roughening
their output. The old stack — five octaves through a two-scale domain warp, with
per-octave swizzles, shears and a midrange widening, all of it fighting the
lattice it was drawn on — survives as `world::terrain_detail` at an amplitude
(±190) below a plate boundary's, so it may texture a mountain range and may not
invent one.

The complaint it could not answer: every island was a smooth lump, every
coastline was an iso-line of a scalar field, and nothing in the world had a
*cause*. There was no reason for a range to run where it ran, for a trench to be
beside an arc, or for one island to be near another.

1. **Plates.** Twelve of them tile the sphere as a spherical Voronoi diagram over
   seeds drawn from the world seed; each is continental (38%) or oceanic, and
   each has a drift made tangent to its own centre. A cell knows its plate, its
   second-nearest plate, and how far inside the first it is.
2. **Boundaries.** The relative drift across a boundary, measured along the
   boundary's own normal, decides what happens there:

   | | converging | diverging |
   |---|---|---|
   | continent / continent | collision range (+520) | rift valley (−180) |
   | continent / ocean | cordillera on the continent (+360), trench on the ocean side (−620) | — |
   | ocean / ocean | island arc (+360, narrowed to a chain) with a shallower trench | spreading ridge (+260) |

   The crust's own base elevation is blended across the boundary rather than
   stepped, which is what a continental shelf is.
3. **Volcanism.** Six hotspots, fixed in the mantle — so a plate drifting over
   one leaves a *chain* rather than a single cone. The cone is cubed, because a
   volcano is a spike and not a dome.
4. **Erosion**, in the order it happens. *Hydraulic*: twelve routing passes
   accumulate the drainage network (a cell collects the flow of every uphill
   neighbour), then the cut goes as flow × slope — stream power — so a trunk
   valley cuts deeper than the gullies feeding it, which is the shape that reads
   as a river system. *Thermal*: eight rounds of talus against a repose of a
   terrace and a half. The talus is what makes a coast shelve instead of dropping
   off as a flat cut-out along cell edges, and it was the pass being run least.

Fertility comes out of the same drainage rather than a second noise field: low,
flat and watered ground is fertile, which puts the good soil in the river
valleys where it belongs.

Seamless by construction, exactly as before: every term above is a pure function
of the cell's position **on the cube, in 3D**, so adjacent cells across a face
boundary are adjacent in 3D too and no per-face fixup exists to get wrong. The
erosion passes are neighbour passes and run on the ghost ring like every other
neighbour pass in the crate.

Sea level is a **quantile**, not a bias: `set_sea_level` binary-searches the
height that leaves the profile's requested dry fraction above it, and shifts the
whole field by it — so zero keeps meaning sea level and the tide's numbers stay
absolute. Profiles ask for what they want directly (archipelago 300 per mille
dry, pangaea 620, volcano 380), where the old bias controlled land fraction only
indirectly and had to be re-measured whenever anything upstream moved.
`world::tests::terrain_profiles_produce_playable_land` still pins land fraction,
rock cells, real peaks and real ocean floor across four seeds per profile.

A histogram was the obvious way to find that quantile and it was wrong here: two
kilobytes on the stack is nothing natively and is enough to overflow the wasm
shadow stack when `init` is reached through `dio_replay`'s deeper frame. It
surfaced as `memory access out of bounds` in the browser and in nothing else —
`just verify-cross` doing exactly the job it exists for.

### There is no road

The **contact corridor is gone from real matches** (user decision). A ridge
running half the planet's circumference between the two spawns, laid across
whatever geology happened to be under it, was the most artificial thing in the
world. Two peoples starting on separate islands is now a legal opening, and
raising the land between them is the player's problem — which is the verb the
game is about.

It survives behind `MapConfig::land_bridge`, off by default, because the §6.3
corpus needs it: the corpus asks for 200 combat resolutions across ten scripted
matches, and armies that never meet resolve none. A corpus log states
`land_bridge 1` for itself, the same way it now states its own tide.
