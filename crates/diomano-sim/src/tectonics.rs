//! Where the land comes from. HANDOFF §3.3, superseding its noise-field
//! `[START]` by user decision.
//!
//! # Why a geology and not a noise field
//!
//! The old generator was five octaves of value noise through a domain warp,
//! and it produced exactly what that produces: blobs. Every island was a
//! smooth lump, every coastline was an iso-line of a scalar field, and nothing
//! in the world had a *cause* — no reason for a mountain range to run where it
//! ran, for a trench to be beside an arc, or for one island to be near
//! another. Played, it read as a texture rather than as a planet.
//!
//! So the height field is assembled from the three processes that actually
//! make one:
//!
//! 1. **Tectonics.** A dozen plates tile the sphere, each continental or
//!    oceanic, each drifting. Their boundaries do what real boundaries do:
//!    two continents colliding raise a range, an ocean plate diving under a
//!    continent raises a coastal cordillera *and* digs a trench in front of it,
//!    two ocean plates make an island arc, and plates pulling apart open a rift
//!    on land and a spreading ridge at sea.
//! 2. **Volcanism.** Fixed hotspots, which the plates drift over, so a hotspot
//!    leaves a *chain* of islands rather than one cone — and arc volcanoes
//!    along the subducting boundaries.
//! 3. **Erosion.** Water is routed downhill until it has found the drainage
//!    network, and the network cuts. That is what turns a smooth uplift into
//!    a landscape with valleys, and it is what makes a coastline ragged in the
//!    way a threshold on a smooth field never is.
//!
//! The noise is still here, but demoted to what noise is good for: breaking up
//! the regularity of the above, at an amplitude that cannot invent a mountain.
//!
//! # Determinism
//!
//! Everything is integer, everything is a pure function of the cell's **3D cube
//! point** and the world seed, and nothing samples a neighbour by face. That is
//! the same argument the old generator relied on for seam continuity, and it
//! survives unchanged: two cells either side of a face boundary are adjacent
//! points in the same field, so `terrain_is_continuous_across_every_seam` holds
//! for the same reason it always did.
//!
//! The erosion passes *are* neighbour passes, and they run on the ghost ring
//! like every other neighbour pass in the crate.

use crate::hash::hash3;
use crate::world::{CELLS, HEIGHT_MAX, HEIGHT_MIN, N, World, cube_point, idx, neighbour_flat};

/// Unit length for the integer direction vectors. A power of two so the
/// normalisation is a shift.
const UNIT: i32 = 4096;

/// How many plates tile the sphere.
///
/// Twelve is enough for the boundary network to have junctions and for a map
/// to hold two or three distinct continents; fewer and every map is one
/// supercontinent and one ocean, more and no plate is bigger than the area a
/// player can see at once, so the geology stops being legible as geology.
const PLATE_COUNT: usize = 12;

/// The width of a plate boundary's influence, in the squared-distance units
/// `nearest_plates` returns.
///
/// Derived rather than tuned: for unit vectors of length `UNIT`, the gap
/// between the nearest and second-nearest plate grows as about
/// `4 * UNIT^2 * sin(theta) * x` with `x` the angular distance to the boundary,
/// and a cell is 0.0245 rad wide at N = 64. This is the value that puts the
/// band at roughly six cells, which is a mountain range and not a wall.
const BOUNDARY_SCALE: i32 = 6_000_000;

/// Elevations, in height units. A terrace is 16 and the field saturates at
/// 8192, so these are deliberately nowhere near the ceiling: erosion and the
/// boundary terms add to them.
const CONTINENT_BASE: i32 = 170;
const OCEAN_BASE: i32 = -520;

/// Peak uplift of a continent-continent collision. The Himalaya term.
///
/// These are all about half what the first cut used, and the first cut was
/// wrong in a way that only a screenshot could show: the renderer's snowline
/// stands at 400 height units above the waterline, so a range that reached
/// 1,100 put permanent ice on every mountain on the planet and the world came
/// out white. Relief has to be read against the shading thresholds it will be
/// drawn with, not against the field's own headroom.
const COLLISION_UPLIFT: i32 = 520;
/// Peak uplift of the cordillera above a subducting slab.
const ARC_UPLIFT: i32 = 360;
/// Depth of the trench in front of it.
const TRENCH_DEPTH: i32 = 620;
/// Uplift of a mid-ocean spreading ridge.
const RIDGE_UPLIFT: i32 = 260;
/// Depth of a continental rift valley.
const RIFT_DEPTH: i32 = 180;

/// How many rounds of talus the generator runs, and the slope it will not
/// tolerate.
///
/// Eight rounds at a repose of a terrace and a half, rather than three at
/// three terraces. The first numbers left every coast a vertical cut-out
/// dropping into the sea along cell edges — a shore is *made* of talus, and
/// the pass that produces it was the one being run least.
const TALUS_PASSES: u32 = 8;
const REPOSE_HEIGHT: i32 = crate::world::TERRACE as i32 * 3 / 2;

/// Hotspots, and how tall an island one builds directly over it.
const HOTSPOT_COUNT: usize = 6;
const HOTSPOT_HEIGHT: i32 = 470;
/// Angular reach of a hotspot's cone, in squared-distance units.
const HOTSPOT_REACH: i32 = 900_000;

/// A plate: where it is centred, which way it drifts, and what it is made of.
#[derive(Clone, Copy)]
struct Plate {
    /// Unit vector to the plate's centre, length `UNIT`.
    centre: [i32; 3],
    /// Drift, as a tangent vector at `centre`. Magnitude is arbitrary but
    /// consistent across plates, so differences are comparable.
    drift: [i32; 3],
    /// True for continental crust, which floats high; false for oceanic.
    continental: bool,
}

/// The world's plates, drawn from the seed.
fn plates(seed: u32) -> [Plate; PLATE_COUNT] {
    let mut out = [Plate { centre: [UNIT, 0, 0], drift: [0; 3], continental: false }; PLATE_COUNT];
    for (i, plate) in out.iter_mut().enumerate() {
        let k = i as i32;
        // Three hashes to a point in the cube, then normalised onto the sphere.
        // A cube-uniform point normalised is not sphere-uniform — the corners
        // are over-represented — and that is fine here: plates are not supposed
        // to be a Poisson disc, and the bias is far smaller than the variation
        // between any two seeds.
        let mut v = [
            (hash3(k, 11, 3, seed ^ 0x9E37_79B9) >> 20) as i32 - 2048,
            (hash3(k, 29, 7, seed ^ 0x85EB_CA6B) >> 20) as i32 - 2048,
            (hash3(k, 53, 13, seed ^ 0xC2B2_AE35) >> 20) as i32 - 2048,
        ];
        // A point at the origin has no direction. Nudge rather than reject, so
        // the plate count is a constant and the loop has no failure branch.
        if v[0].abs() + v[1].abs() + v[2].abs() < 256 {
            v[0] += 1024 + k;
            v[1] -= 768;
        }
        plate.centre = normalise(v);

        // The drift is any vector made tangent to the centre, so a plate never
        // drifts into or out of the planet.
        let raw = [
            (hash3(k, 101, 17, seed ^ 0x27D4_EB2F) >> 21) as i32 - 1024,
            (hash3(k, 137, 19, seed ^ 0x1656_67B1) >> 21) as i32 - 1024,
            (hash3(k, 173, 23, seed ^ 0x7FEB_352D) >> 21) as i32 - 1024,
        ];
        plate.drift = tangent(raw, plate.centre);

        // Rather more ocean than land, as on the planet this is modelled on.
        plate.continental = (hash3(k, 211, 29, seed ^ 0x94D0_49BB) >> 8) % 100 < 38;
    }
    out
}

/// Hotspot centres. Fixed in the mantle, which is the whole point of them.
fn hotspots(seed: u32) -> [[i32; 3]; HOTSPOT_COUNT] {
    let mut out = [[UNIT, 0, 0]; HOTSPOT_COUNT];
    for (i, spot) in out.iter_mut().enumerate() {
        let k = i as i32;
        let mut v = [
            (hash3(k, 307, 31, seed ^ 0x2545_F491) >> 20) as i32 - 2048,
            (hash3(k, 311, 37, seed ^ 0x9E37_79B1) >> 20) as i32 - 2048,
            (hash3(k, 313, 41, seed ^ 0xD6E8_FEB8) >> 20) as i32 - 2048,
        ];
        if v[0].abs() + v[1].abs() + v[2].abs() < 256 {
            v[2] += 1500 - k;
        }
        *spot = normalise(v);
    }
    out
}

/// Which two plates a point belongs to, and how far inside the nearer one.
struct Nearest {
    first: usize,
    second: usize,
    /// `d2(second) - d2(first)`: zero on the boundary, growing inward.
    gap: i32,
}

fn nearest_plates(p: [i32; 3], plates: &[Plate; PLATE_COUNT]) -> Nearest {
    let mut best = (i32::MAX, 0usize);
    let mut next = (i32::MAX, 0usize);
    for (i, plate) in plates.iter().enumerate() {
        let d = dist2(p, plate.centre);
        if d < best.0 {
            next = best;
            best = (d, i);
        } else if d < next.0 {
            next = (d, i);
        }
    }
    Nearest { first: best.1, second: next.1, gap: next.0.saturating_sub(best.0) }
}

/// Build the height field. Returns nothing: it writes `w.height` and leaves
/// every other field alone.
pub fn raise_land(w: &mut World, ocean_bias: i32, hotspot_gain: i32) {
    let seed = w.cfg.seed;
    let plates = plates(seed);
    let spots = hotspots(seed);

    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let (cx, cy, cz) = cube_point(face, x as i32, y as i32);
                let p = normalise([cx, cy, cz]);
                let near = nearest_plates(p, &plates);
                let a = plates[near.first];
                let b = plates[near.second];

                // How much of this cell is "boundary". 65536 on the line
                // itself, 0 well inside a plate.
                let edge = 65536 - smooth01(near.gap, BOUNDARY_SCALE);

                // The crust it sits on. Blended across the boundary, so a
                // continent does not end in a vertical wall at a plate edge —
                // the continental shelf is exactly this blend.
                let own = if a.continental { CONTINENT_BASE } else { OCEAN_BASE };
                let other = if b.continental { CONTINENT_BASE } else { OCEAN_BASE };
                let mut h = own + (other - own) * edge / 131_072;

                // Which way the two plates are moving relative to each other,
                // measured along the boundary's own normal. Positive is
                // converging.
                let axis = [
                    b.centre[0] - a.centre[0],
                    b.centre[1] - a.centre[1],
                    b.centre[2] - a.centre[2],
                ];
                let rel =
                    [a.drift[0] - b.drift[0], a.drift[1] - b.drift[1], a.drift[2] - b.drift[2]];
                // Scaled into roughly -65536..65536. The divisor is the product
                // of the two magnitudes' order: drift is ~1024, the axis
                // between two plate centres is ~4096.
                let converge = (dot(rel, axis) / 128).clamp(-65536, 65536);

                if edge > 0 {
                    let band = q16(edge, edge); // sharpen: ranges are narrow
                    if converge > 0 {
                        let force = q16(converge, band);
                        if a.continental && b.continental {
                            // Two continents: nowhere for either to go but up.
                            h += COLLISION_UPLIFT * force / 65536;
                        } else if a.continental {
                            // The ocean plate dives under this one: a
                            // cordillera along the coast.
                            h += ARC_UPLIFT * force / 65536;
                        } else if b.continental {
                            // This is the plate going down. The trench sits on
                            // this side of the line, in front of the range.
                            h -= TRENCH_DEPTH * force / 65536;
                        } else {
                            // Ocean under ocean: an island arc, and the arc is
                            // narrow, which is what makes it a *chain*.
                            let arc = q16(band, band);
                            h += ARC_UPLIFT * converge / 65536 * arc / 65536;
                            h -= TRENCH_DEPTH / 3 * force / 65536;
                        }
                    } else {
                        let force = q16(-converge, band);
                        if a.continental {
                            // A continent pulling apart drops a rift valley.
                            h -= RIFT_DEPTH * force / 65536;
                        } else {
                            // The sea floor pulling apart is where new sea
                            // floor is made, and it is *shallower* than the
                            // abyss on either side.
                            h += RIDGE_UPLIFT * force / 65536;
                        }
                    }
                }

                // Hotspots. A cone in the mantle, so an island sits over it
                // and the plate carries the older ones away in a line.
                for spot in &spots {
                    let d = dist2(p, *spot);
                    if d < HOTSPOT_REACH {
                        let t = 65536 - smooth01(d, HOTSPOT_REACH);
                        // Cubed: a volcano is a spike, not a dome.
                        let cone = q16(q16(t, t), t);
                        h += HOTSPOT_HEIGHT * cone / 65536 * hotspot_gain / 256;
                    }
                }

                // Noise, demoted to what noise is for: roughening everything
                // above so it does not read as arithmetic. The amplitude is
                // below a plate boundary's, deliberately — it may not invent a
                // mountain range, only texture one.
                h += crate::world::terrain_detail(cx, cy, cz, seed);

                h -= ocean_bias;
                w.height[idx(face, x, y)] =
                    h.clamp(i32::from(HEIGHT_MIN), i32::from(HEIGHT_MAX)) as i16;
            }
        }
    }
}

/// Cut the drainage network into the uplift, and let the debris come to rest.
///
/// # Two processes, in the order they happen
///
/// **Hydraulic.** Water falls everywhere and runs downhill, and the further it
/// has run the more it carries and the harder it cuts. So the first pass routes
/// a unit of flow from every cell to its lowest neighbour and repeats, which
/// accumulates the drainage network in `sediment` — after `k` passes a cell
/// holds the number of cells within `k` steps upstream of it. The second cuts
/// in proportion to that, so a trunk valley cuts deeper than the gullies
/// feeding it, which is the shape that reads as a river system.
///
/// **Thermal.** Rock that is too steep to stand falls. A symmetric relaxation
/// against a repose limit, which rounds ridge lines and puts talus at the foot
/// of cliffs, and is also what makes a coastline ragged rather than an iso-line
/// of a smooth field.
///
/// `water` and `sediment` are used as scratch: both are overwritten by the sea
/// fill immediately after this returns, and neither has meaningful contents
/// before it. That is the whole reason this needs no allocation.
pub fn erode(w: &mut World, passes: u32, cut: i32) {
    // --- drainage ---------------------------------------------------------
    for c in 0..CELLS {
        w.sediment[c] = 1;
    }
    for _ in 0..passes {
        w.ghost_copy_all();
        // The previous pass's accumulation, so a cell cannot drain into a
        // neighbour that has already drained into it inside the same pass.
        for c in 0..CELLS {
            w.water[c] = i16::from(w.sediment[c]);
        }
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    let here = i32::from(w.height[c]);
                    let mut acc = 1i32;
                    for dir in 0..4usize {
                        let n = neighbour_flat(c, dir);
                        // Uphill neighbours drain into this cell. Ties go
                        // nowhere, which is what stops two flat neighbours from
                        // pumping flow back and forth forever.
                        if i32::from(w.height[n]) > here {
                            acc += i32::from(w.water[n]);
                        }
                    }
                    w.sediment[c] = acc.min(255) as u8;
                }
            }
        }
    }

    // --- the cut ----------------------------------------------------------
    w.ghost_copy_all();
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                let here = i32::from(w.height[c]);
                // Stream power: the cut goes as the flow and as the slope. A
                // flat plain with a big river on it is a flood plain, not a
                // canyon, and this is the term that knows the difference.
                let mut drop = 0i32;
                for dir in 0..4usize {
                    let n = neighbour_flat(c, dir);
                    drop = drop.max(here - i32::from(w.height[n]));
                }
                let flow = i32::from(w.sediment[c]);
                let carved = flow * drop.max(0) * cut / 4096;
                // Never below the plate's own floor: erosion lowers land, it
                // does not dig new abyss.
                let floor = OCEAN_BASE - 400;
                w.height[c] = (here - carved.min(here.saturating_sub(floor).max(0))) as i16;
            }
        }
    }

    // --- talus ------------------------------------------------------------
    for _ in 0..TALUS_PASSES {
        w.ghost_copy_all();
        for c in 0..CELLS {
            w.water[c] = w.height[c];
        }
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    let here = i32::from(w.water[c]);
                    let mut sum = 0i32;
                    for dir in 0..4usize {
                        sum += i32::from(w.water[neighbour_flat(c, dir)]);
                    }
                    let mean = sum / 4;
                    // Only where the slope is beyond repose: below it, the
                    // shape is meant to survive.
                    let excess = (here - mean).abs() - REPOSE_HEIGHT;
                    if excess > 0 {
                        let pull = (mean - here) * excess.min(512) / 768;
                        w.height[c] = (here + pull) as i16;
                    }
                }
            }
        }
    }
    w.ghost_copy_all();
}

/// Shift the whole field so that `target` per mille of the surface is dry.
///
/// A quantile of the height field, rather than the old profile's hand-tuned
/// bias with a two-sided stretch on top of it. The bias was measured once against
/// one version of the noise stack and had to be re-measured whenever anything
/// upstream moved — and it controlled the land fraction only indirectly, which
/// is why `terrain_profiles_produce_playable_land` was a range rather than a
/// number. This asks for the land fraction directly and gets it.
pub fn set_sea_level(w: &mut World, target_per_mille: i32) {
    // Live cells only: the ghost ring is a copy of the border and counting it
    // would weight the twelve cube edges twice.
    let total = 6 * (N * N) as i32;
    let want = total * target_per_mille / 1000;

    // Binary search for the height that leaves `want` cells above it.
    //
    // A 512-bucket histogram was the obvious way to do this and it was wrong
    // here: two kilobytes on the stack, which is nothing natively and is enough
    // to overflow the wasm shadow stack when `init` is reached through
    // `dio_replay`'s deeper frame rather than through `dio_init`'s. It showed up
    // as `memory access out of bounds` in the browser and in nothing else,
    // which is exactly the divergence `just verify-cross` exists to find.
    //
    // Fifteen passes over 24,576 cells is a few hundred thousand comparisons at
    // world generation, once. It needs no memory at all, and it is exact rather
    // than quantised to a bucket.
    let mut lo = i32::from(HEIGHT_MIN);
    let mut hi = i32::from(HEIGHT_MAX);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        let mut above = 0i32;
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    if i32::from(w.height[idx(face, x, y)]) > mid {
                        above += 1;
                    }
                }
            }
        }
        // More land than asked for means the waterline has to rise.
        if above > want { lo = mid } else { hi = mid }
    }

    // Move the *land*, not the sea: `sea_level` is simulation state that the
    // tide and the flood power both ride on, and starting a match with it
    // somewhere other than zero would make every one of their numbers relative
    // to the map. Shifting the height field keeps zero meaning sea level.
    for c in 0..CELLS {
        w.height[c] = (i32::from(w.height[c]) - lo)
            .clamp(i32::from(HEIGHT_MIN), i32::from(HEIGHT_MAX)) as i16;
    }
    w.ghost_copy_all();
}

// ---------------------------------------------------------------------------
// Integer vector helpers
// ---------------------------------------------------------------------------

/// `a * b` in Q16.
///
/// Through i64, because `65536 * 65536` is exactly `2^32` and overflows i32 —
/// and `overflow-checks` is on in *every* profile here, so that is a panic
/// rather than a silent wrap. It is the same trap `world::smooth` documents,
/// and it caught this module on its first run.
fn q16(a: i32, b: i32) -> i32 {
    ((i64::from(a) * i64::from(b)) >> 16) as i32
}

fn dot(a: [i32; 3], b: [i32; 3]) -> i32 {
    // The inputs here are bounded by a few thousand each, so the products are
    // well inside i32 — but the sum of three of them is not obviously so, and
    // `overflow-checks` is on in every profile. i64 costs nothing at this rate.
    let s = i64::from(a[0]) * i64::from(b[0])
        + i64::from(a[1]) * i64::from(b[1])
        + i64::from(a[2]) * i64::from(b[2]);
    s.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn dist2(a: [i32; 3], b: [i32; 3]) -> i32 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    dot(d, d)
}

/// Scale a vector to length `UNIT`.
fn normalise(v: [i32; 3]) -> [i32; 3] {
    let len = isqrt(dot(v, v).max(1));
    [v[0] * UNIT / len, v[1] * UNIT / len, v[2] * UNIT / len]
}

/// The component of `v` perpendicular to `axis`, where `axis` has length `UNIT`.
fn tangent(v: [i32; 3], axis: [i32; 3]) -> [i32; 3] {
    let along = dot(v, axis) / UNIT;
    [v[0] - axis[0] * along / UNIT, v[1] - axis[1] * along / UNIT, v[2] - axis[2] * along / UNIT]
}

/// Integer square root, by bit-by-bit restoring. Hand-rolled for the reason
/// §9.2 gives for the rest of the math: owning the stack is the point.
fn isqrt(v: i32) -> i32 {
    if v <= 0 {
        return 0;
    }
    let mut bit = 1i64 << 30;
    let v = i64::from(v);
    while bit > v {
        bit >>= 2;
    }
    let mut rest = v;
    let mut root = 0i64;
    while bit != 0 {
        if rest >= root + bit {
            rest -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    root.max(1) as i32
}

/// `smoothstep(0, span, v)` in Q16, saturating.
fn smooth01(v: i32, span: i32) -> i32 {
    if v >= span {
        return 65536;
    }
    if v <= 0 {
        return 0;
    }
    let t = (i64::from(v) * 65536 / i64::from(span)) as i32;
    // t^2 (3 - 2t) in Q16, through i64 so the square cannot overflow.
    let t2 = i64::from(t) * i64::from(t) / 65536;
    (t2 * (3 * 65536 - 2 * i64::from(t)) / 65536 / 65536) as i32
}
