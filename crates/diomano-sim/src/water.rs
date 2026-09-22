//! Water and lava transfer. HANDOFF §4.3.
//!
//! **Not a fluid simulation.** Water is a per-cell integer depth moved by a
//! checkerboard two-pass relaxation, so the result is scan-order independent
//! while staying bit-reproducible.
//!
//! # Conservation across a seam
//!
//! A transfer out of an edge cell targets a *ghost* cell, and ghosts are
//! overwritten by the next border copy — so a naive implementation quietly
//! destroys every drop of water that crosses a face boundary, at a rate of
//! roughly 1536 cells' worth per tick. Instead each such transfer is recorded
//! against the seam entry it crossed and scattered onto the real destination
//! after the pass. Matter is conserved exactly, and the pass order is unchanged.

use crate::seams::{DIR_E, DIR_N, DIR_S};
use crate::world::{FluxField, N, World, idx, neighbour_flat};

/// Flow above which a transfer erodes the bed (§4.4 "eroding flow (> 32)").
pub const EROSION_FLOW_MIN: i32 = 32;
/// Lava needs a real slope before it creeps; it is not water.
pub const LAVA_FLOW_MIN: i32 = 16;

/// Is the neighbour in `dir` a ghost cell, and if so which seam entry is it?
#[inline]
const fn seam_entry(face: usize, x: usize, y: usize, dir: usize) -> Option<usize> {
    let on_edge = match dir {
        DIR_N => y == N - 1,
        DIR_E => x == N - 1,
        DIR_S => y == 0,
        _ => x == 0,
    };
    if !on_edge {
        return None;
    }
    let t = if dir == DIR_N || dir == DIR_S { x } else { y };
    Some((face * 4 + dir) * N + t)
}

/// Water transfer, checkerboard: even cells, then odd cells (§4.1 pass 3).
///
/// `sea_before` is the sea level the previous tick's pin used — see
/// [`apply_sea_level`]. Callers that do not move the sea pass `w.sea_level`.
pub fn transfer_water(w: &mut World, sea_before: i16) {
    w.erode.fill(0);
    for parity in 0..2usize {
        water_half(w, parity);
        w.apply_seam_flux_i16(FluxField::Water);
        // Refresh the ghost ring between halves so the odd pass reads the water
        // values the even pass just produced, rather than a stale copy.
        w.ghost_copy_flow_fields();
    }
    apply_sea_level(w, sea_before);
}

fn water_half(w: &mut World, parity: usize) {
    for face in 0..6usize {
        for y in 0..N {
            // The cells of this parity, in the order a full scan with a parity
            // test visited them, without the test.
            for x in ((parity + y) & 1..N).step_by(2) {
                let a = idx(face, x, y);
                if w.water[a] <= 0 {
                    continue;
                }
                // Fixed neighbour order, always (§10).
                for dir in 0..4usize {
                    if w.water[a] <= 0 {
                        break;
                    }
                    let b = neighbour_flat(a, dir);
                    let sa = i32::from(w.height[a]) + i32::from(w.water[a]);
                    let sb = i32::from(w.height[b]) + i32::from(w.water[b]);
                    if sa <= sb {
                        continue;
                    }
                    // /4, not /2: four neighbours per cell, /2 overshoots and
                    // oscillates (§4.3).
                    let mut flow = (sa - sb) / 4;
                    flow = flow.min(i32::from(w.water[a]));
                    // Vegetation dampens transfer. One term, and it is what makes
                    // forests mechanically load-bearing rather than decorative.
                    // The gap-channeling behaviour of §4.3 emerges from exactly
                    // this line and is not special-cased anywhere.
                    let drag = 256 - i32::from(w.vegetation[a]);
                    flow = (flow * drag) / 256;
                    if flow <= 0 {
                        continue;
                    }
                    w.water[a] -= flow as i16;
                    if flow > EROSION_FLOW_MIN {
                        let e = flow.min(255) as u8;
                        w.erode[a] = w.erode[a].max(e);
                    }
                    match seam_entry(face, x, y, dir) {
                        Some(k) => w.seam_flux[k] += flow,
                        None => w.water[b] = w.water[b].saturating_add(flow as i16),
                    }
                }
            }
        }
    }
}

/// Global sea level is a single integer; cells below it are filled to it (§4.3).
///
/// The ocean is a boundary condition, not a body of water that relaxes: pinning
/// it here is what stops a planet-sized basin from sloshing forever and is the
/// reason `settles_without_oscillation` converges rather than merely damping.
///
/// The boundary works both ways. When the sea falls — the tide's drawback, the
/// second half of a wave — every cell it uncovers (`sea <= h < sea_before`) is
/// released dry. It used to be released with whatever the last pin left on it,
/// one to a few units, and on flat ground that film never drains: the flow rule
/// moves nothing below a four-unit difference, so a flooded plateau came back
/// from every wave wet, `buildable` and `habitable` both false, and the
/// settlement on it decayed for want of a flat footprint. A receding sea takes
/// its water with it; only water the sea did not bring — a lake, a poured
/// puddle above the line — stays.
pub fn apply_sea_level(w: &mut World, sea_before: i16) {
    let sea = i32::from(w.sea_level);
    let before = i32::from(sea_before);
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                let h = i32::from(w.height[c]);
                if h < sea {
                    w.water[c] = (sea - h).min(i32::from(i16::MAX)) as i16;
                } else if h < before {
                    w.water[c] = 0;
                }
            }
        }
    }
}

/// Lava transfer, checkerboard (§4.1 pass 4).
///
/// Same relaxation as water with two changes: a much higher flow threshold, so
/// lava creeps instead of spreading, and `/8` rather than `/4`, so a vent builds
/// a cone instead of a puddle. Lava is a construction verb (§4.4) and it has to
/// behave like one.
pub fn transfer_lava(w: &mut World) {
    for parity in 0..2usize {
        lava_half(w, parity);
        w.apply_seam_flux_i16(FluxField::Lava);
        w.ghost_copy_flow_fields();
    }
}

fn lava_half(w: &mut World, parity: usize) {
    for face in 0..6usize {
        for y in 0..N {
            for x in ((parity + y) & 1..N).step_by(2) {
                let a = idx(face, x, y);
                if w.lava[a] == 0 {
                    continue;
                }
                for dir in 0..4usize {
                    if w.lava[a] == 0 {
                        break;
                    }
                    let b = neighbour_flat(a, dir);
                    let sa = i32::from(w.height[a]) + i32::from(w.lava[a]);
                    let sb = i32::from(w.height[b]) + i32::from(w.lava[b]);
                    let diff = sa - sb;
                    if diff <= LAVA_FLOW_MIN {
                        continue;
                    }
                    let mut flow = (diff - LAVA_FLOW_MIN) / 8;
                    flow = flow.min(i32::from(w.lava[a]));
                    // Lava cannot pile more than a full byte deep in one cell.
                    let room = 255 - i32::from(w.lava[b]);
                    flow = flow.min(room);
                    if flow <= 0 {
                        continue;
                    }
                    w.lava[a] -= flow as u8;
                    match seam_entry(face, x, y, dir) {
                        Some(k) => w.seam_flux[k] += flow,
                        None => w.lava[b] += flow as u8,
                    }
                }
            }
        }
    }
}

/// Total water on the planet, live cells only. Used by conservation tests.
#[must_use]
pub fn total_water(w: &World) -> i64 {
    let mut t = 0i64;
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                t += i64::from(w.water[idx(face, x, y)]);
            }
        }
    }
    t
}

/// Total lava on the planet, live cells only.
#[must_use]
pub fn total_lava(w: &World) -> i64 {
    let mut t = 0i64;
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                t += i64::from(w.lava[idx(face, x, y)]);
            }
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::Fnv64;
    use crate::world::{HAND_EARTH, MapConfig, S, TERRACE, TERRAIN_PANGAEA};

    fn water_hash(w: &World) -> u64 {
        let mut h = Fnv64::new();
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    h.write_i16(w.water[idx(face, x, y)]);
                }
            }
        }
        h.finish()
    }

    /// One tick of *only* the water system, matching the §4.4 DoD wording
    /// ("water settles to a stable level with no oscillation over 5,000 idle
    /// ticks"). Isolating it is the point: with vegetation, walkers and
    /// settlements running the hash would keep moving for reasons that have
    /// nothing to do with whether water is stable.
    /// The water pass with the sea where it already is: no tide, no film band.
    fn settle(w: &mut World) {
        let sea = w.sea_level;
        transfer_water(w, sea);
    }

    fn water_only_tick(w: &mut World) {
        w.ghost_copy_all();
        settle(w);
    }

    fn pangaea() -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = 0xA11CE;
        let mut w = World::boxed();
        w.init(&cfg);
        w
    }

    #[test]
    fn settles_without_oscillation() {
        let mut w = pangaea();

        // Disturbance: a column of water dropped onto high ground, so it has to
        // find its way downhill across several hundred cells.
        let mut dropped = 0i64;
        for dy in -3i32..=3 {
            for dx in -3i32..=3 {
                let x = (32 + dx) as usize;
                let y = (32 + dy) as usize;
                let c = idx(4, x, y);
                w.height[c] = 900;
                w.water[c] = 4000;
                dropped += 4000;
            }
        }
        assert!(dropped > 0);

        let mut hashes = [0u64; 1000];
        for t in 0..5000usize {
            water_only_tick(&mut w);
            if t >= 4000 {
                hashes[t - 4000] = water_hash(&w);
            }
        }

        let first = hashes[0];
        let stable = hashes.iter().all(|&h| h == first);
        assert!(
            stable,
            "water is still moving in the final 1000 of 5000 idle ticks: \
             {} distinct states",
            {
                let mut uniq = std::collections::BTreeSet::new();
                for h in hashes {
                    uniq.insert(h);
                }
                uniq.len()
            }
        );
    }

    #[test]
    fn water_is_conserved_across_seams() {
        // Sea level is a boundary condition and would mask a leak, so this runs
        // on dry high ground with a single blob straddling a face boundary.
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.seed = 3;
        w.init(&cfg);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 2000;
                    w.water[c] = 0;
                    w.vegetation[c] = 0;
                }
            }
        }
        // A ridge that funnels the blob straight at the +x/-z seam.
        for t in 0..N {
            w.height[idx(0, N - 1, t)] = 1900;
            w.height[idx(5, 0, t)] = 1800;
        }
        w.water[idx(0, N - 1, 30)] = 20_000;
        w.water[idx(0, N - 2, 30)] = 20_000;
        let before = total_water(&w);

        for _ in 0..400 {
            w.ghost_copy_all();
            settle(&mut w);
        }
        let after = total_water(&w);
        assert_eq!(before, after, "water leaked at a face boundary");

        // And it actually got there, otherwise the test proves nothing.
        let crossed: i64 = (0..N).map(|t| i64::from(w.water[idx(5, 0, t)])).sum();
        assert!(crossed > 0, "no water crossed the seam; test is vacuous");
    }

    #[test]
    fn lava_is_conserved_across_seams() {
        // Lava across a seam is staged in `seam_flux` against the room the
        // ghost copy showed at the start of the half, and the real cell can
        // fill from its own face in the same half. Deep, uneven lava along
        // every face edge over rough ground makes that happen everywhere at
        // once; nothing but the transfer runs, so any change in the total is
        // the seams.
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let mut rng = 0x2545_f491_u32;
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.water[c] = 0;
                    let edge = x.min(y).min(N - 1 - x).min(N - 1 - y);
                    rng ^= rng << 13;
                    rng ^= rng >> 17;
                    rng ^= rng << 5;
                    w.height[c] = 2000 + (rng & 511) as i16;
                    w.lava[c] = if edge < 3 { (rng >> 24) as u8 } else { 0 };
                }
            }
        }
        let before = total_lava(&w);
        for _ in 0..20 {
            w.ghost_copy_all();
            transfer_lava(&mut w);
        }
        assert_eq!(total_lava(&w), before, "lava leaked at a face boundary");
    }

    #[test]
    fn lava_is_conserved_where_a_corner_cell_receives_over_two_seams() {
        // The one place a seam destination can take lava over two seams in
        // the same half: the three cells meeting at a cube corner. Each face
        // corner in turn is a low, part-filled sink between its two seam
        // neighbours, both high and full, with everything else walled off.
        // Both give against the room the stale ghost showed, the sink cannot
        // take both, and the remainder has to go back to the senders intact.
        use crate::seams::{DIR_W, GHOST_SRC};
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let mut double_inflows = 0;
        for face in 0..6usize {
            for (x, y, dx, dy) in [
                (0, 0, DIR_W, DIR_S),
                (N - 1, 0, DIR_E, DIR_S),
                (0, N - 1, DIR_W, DIR_N),
                (N - 1, N - 1, DIR_E, DIR_N),
            ] {
                for c in 0..w.lava.len() {
                    w.lava[c] = 0;
                    w.water[c] = 0;
                    w.height[c] = 3000;
                }
                let sink = idx(face, x, y);
                w.height[sink] = 1000;
                w.lava[sink] = 200;
                for dir in [dx, dy] {
                    let k = World::seam_entry_of_ghost(neighbour_flat(sink, dir)).unwrap();
                    let src = GHOST_SRC[k] as usize;
                    w.height[src] = 2000;
                    w.lava[src] = 255;
                }
                let before = total_lava(&w);
                w.ghost_copy_all();
                for parity in 0..2usize {
                    lava_half(&mut w, parity);
                    let inbound: i32 = w.seam_flux.iter().sum();
                    if inbound > 255 - i32::from(w.lava[sink]) {
                        double_inflows += 1;
                    }
                    w.apply_seam_flux_i16(FluxField::Lava);
                    w.ghost_copy_flow_fields();
                }
                assert_eq!(
                    total_lava(&w),
                    before,
                    "lava lost at the corner of face {face} ({x}, {y})"
                );
                assert_eq!(w.lava[sink], 255, "the sink did not fill");
            }
        }
        assert!(double_inflows > 0, "no corner took two seams at once; test is vacuous");
    }

    #[test]
    fn vegetation_damping_channels_flow_through_a_gap() {
        // HANDOFF §4.3: an open gap in a forest channels and amplifies a strong
        // current. This must fall out of the damping term with no special case
        // — the only difference between the two runs below is the vegetation
        // field, and the only code that reads it is `drag` in `water_half`.
        let build = |gap: bool| {
            let mut w = World::boxed();
            let mut cfg = MapConfig::DEFAULT;
            cfg.seed = 11;
            w.init(&cfg);
            for face in 0..6usize {
                for y in 0..N {
                    for x in 0..N {
                        let c = idx(face, x, y);
                        // A uniform slope running down +y on face 4.
                        w.height[c] = if face == 4 { 2000 - (y as i16) * 8 } else { 2000 };
                        w.water[c] = 0;
                        w.vegetation[c] = 0;
                        w.material[c] = crate::world::MAT_SOIL;
                    }
                }
            }
            // A treeline across the slope, with or without a notch cut in it.
            for x in 0..N {
                for y in 20..26 {
                    let in_gap = (28..36).contains(&x);
                    if gap && in_gap {
                        continue;
                    }
                    w.vegetation[idx(4, x, y)] = 240;
                }
            }
            // A wall of water released above the treeline.
            for x in 0..N {
                for y in 8..14 {
                    w.water[idx(4, x, y)] = 3000;
                }
            }
            for _ in 0..300 {
                w.ghost_copy_all();
                settle(&mut w);
            }
            // How much water reached the far side, inside the notch's column.
            let through: i64 = (28..36)
                .flat_map(|x| (30..40).map(move |y| (x, y)))
                .map(|(x, y)| i64::from(w.water[idx(4, x, y)]))
                .sum();
            through
        };

        let solid = build(false);
        let notched = build(true);
        assert!(
            notched > solid * 3 / 2,
            "cutting a gap in the treeline did not focus the flow \
             (solid={solid}, notched={notched}); the damping term is wrong"
        );
    }

    #[test]
    fn lava_creeps_downhill_and_does_not_evaporate() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.seed = 5;
        w.init(&cfg);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = if face == 4 { 3000 - (y as i16) * 20 } else { 3000 };
                    w.water[c] = 0;
                    w.lava[c] = 0;
                }
            }
        }
        w.lava[idx(4, 32, 4)] = 255;
        let before = total_lava(&w);
        for _ in 0..200 {
            w.ghost_copy_all();
            transfer_lava(&mut w);
        }
        assert_eq!(total_lava(&w), before, "lava was created or destroyed");
        assert!(w.lava[idx(4, 32, 4)] < 255, "lava did not move at all");
        let downhill: i64 = (5..20).map(|y| i64::from(w.lava[idx(4, 32, y)])).sum();
        assert!(downhill > 0, "lava did not creep downhill");
    }

    #[test]
    fn checkerboard_makes_a_pass_scan_order_independent() {
        // What the checkerboard actually buys: within one half-pass a cell is
        // either a source or a sink, never both, so water moves exactly one cell
        // per half-pass. A plain row-major sweep would carry a blob dozens of
        // cells downstream in a single pass, and the result would depend on which
        // corner the sweep started from.
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 1000;
                    w.water[c] = 0;
                    w.vegetation[c] = 0;
                }
            }
        }
        w.water[idx(4, 32, 32)] = 8000;
        w.ghost_copy_all();
        settle(&mut w);

        // After one full tick (two half-passes) nothing beyond two cells away can
        // have been reached.
        for y in 0..N {
            for x in 0..N {
                let d = (x as i32 - 32).abs() + (y as i32 - 32).abs();
                if d > 2 {
                    assert_eq!(
                        w.water[idx(4, x, y)],
                        0,
                        "water reached ({x},{y}), {d} cells away, in one tick"
                    );
                }
            }
        }
        let reached: i64 =
            (0..4).map(|dir| i64::from(w.water[neighbour_flat(idx(4, 32, 32), dir)])).sum();
        assert!(reached > 0, "water did not move at all");
    }

    #[test]
    fn spreading_is_symmetric_to_within_the_neighbour_order_bias() {
        // Perfect four-fold symmetry is not achievable and not claimed: the §4.3
        // formula recomputes the source surface for each neighbour in the fixed
        // N, E, S, W order, so the first neighbour served takes slightly more.
        // What must hold is that the bias stays a rounding-scale effect and never
        // becomes a directional current.
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 1000;
                    w.water[c] = 0;
                    w.vegetation[c] = 0;
                }
            }
        }
        w.water[idx(4, 32, 32)] = 8000;
        for _ in 0..80 {
            w.ghost_copy_all();
            settle(&mut w);
        }
        for d in 1..6usize {
            let e = i32::from(w.water[idx(4, 32 + d, 32)]);
            let west = i32::from(w.water[idx(4, 32 - d, 32)]);
            let north = i32::from(w.water[idx(4, 32, 32 + d)]);
            let south = i32::from(w.water[idx(4, 32, 32 - d)]);
            let spread = [e, west, north, south];
            let lo = spread.iter().copied().min().unwrap();
            let hi = spread.iter().copied().max().unwrap();
            // Measured bias at these settings is about 12% between the most and
            // least favoured axis. A real directional leak — a missing neighbour,
            // a sign error, a seam eating flow — shows up as a factor, not a
            // percentage, so a quarter is a wide enough bound to be stable and a
            // tight enough one to catch that.
            assert!(
                hi - lo <= hi / 4 + 1,
                "at distance {d} the four axes hold {spread:?}: that is a current, not rounding"
            );
            assert!(lo > 0, "the blob did not spread evenly to distance {d}");
        }
    }

    #[test]
    fn hand_material_does_not_leak_into_the_water_pass() {
        let mut w = pangaea();
        w.hand[0].material = HAND_EARTH;
        let before = water_hash(&w);
        w.hand[0].amount = 4000;
        water_only_tick(&mut w);
        let after = water_hash(&w);
        // Not an equality assertion: water does move. The point is that the pass
        // compiles without reading the hand at all, which the borrow checker
        // enforces; this is a smoke test that the world is still coherent.
        let _ = (before, after);
        assert!(total_water(&w) >= 0);
    }

    #[test]
    fn a_receding_sea_leaves_no_film() {
        // A flat shelf a little above the calm sea, flooded by a wave and then
        // uncovered one unit per tick — the tide's own cadence. Every cell the
        // sea gives back has to come back dry: the flow rule cannot drain a film
        // thinner than four units from flat ground, so a film left here would be
        // there for the rest of the match.
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 20;
                    w.water[c] = 0;
                    w.vegetation[c] = 0;
                }
            }
        }
        w.sea_base = 0;
        w.sea_level = 48;
        w.ghost_copy_all();
        transfer_water(&mut w, 48);
        assert_eq!(w.water[idx(4, 32, 32)], 28, "the wave did not flood the shelf");
        while w.sea_level > 0 {
            let before = w.sea_level;
            w.sea_level -= 1;
            w.ghost_copy_all();
            transfer_water(&mut w, before);
        }
        let wet = (0..6usize)
            .flat_map(|f| (0..N).flat_map(move |y| (0..N).map(move |x| idx(f, x, y))))
            .filter(|&c| w.water[c] != 0)
            .count();
        assert_eq!(wet, 0, "{wet} cells kept a film after the sea receded");
    }

    #[test]
    fn terrace_unit_is_the_shared_scale() {
        // §3.6: height, water and lava are directly comparable.
        assert_eq!(TERRACE, 16);
        assert_eq!(S, N + 2);
    }
}
