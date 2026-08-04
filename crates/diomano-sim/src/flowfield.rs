//! Flow field. HANDOFF §4.5.
//!
//! Integer-cost BFS from targets over passable cells, producing a per-cell
//! direction field. Neighbour iteration order is fixed N, E, S, W — never
//! derived from a hash or a set.
//!
//! Recomputed on a fixed tick boundary, every 15 ticks, **never immediately on
//! terrain change**. Immediate recompute would couple the result to event
//! ordering, which is how a lockstep desync starts.

use crate::seams::opposite;
use crate::world::{NO_FLOW, PLAYERS, TIER_STRENGTH, World, idx, live_neighbour};

/// Unreachable marker for the BFS distance scratch.
pub const UNREACHED: u16 = u16::MAX;

/// Cells per point of tier strength (§4.5 `[START]` `INFLUENCE_REACH = 6`).
pub const INFLUENCE_REACH: i32 = 6;

/// Rebuild both players' flow fields.
pub fn rebuild(w: &mut World) {
    for player in 0..PLAYERS {
        rebuild_for(w, player);
    }
}

fn rebuild_for(w: &mut World, player: usize) {
    w.dist[player].fill(UNREACHED);
    w.flow[player].fill(NO_FLOW);

    let mut head = 0usize;
    let mut tail = 0usize;

    // Targets, in a fixed order: the papal magnet first, then settlements by
    // slot index. The magnet is the only command in the game (§5.1), so it
    // outranks everything a walker would otherwise wander towards.
    if w.magnet[player].active != 0 {
        let m = w.magnet[player];
        let c = idx(m.face as usize, m.x as usize, m.y as usize);
        if w.dist[player][c] == UNREACHED {
            w.dist[player][c] = 0;
            w.queue[tail] = c as u32;
            tail += 1;
        }
    } else {
        // No magnet: seek the largest buildable plateau inside own influence
        // (§4.5). The plateau field is already computed by the settlement pass,
        // so "largest" costs a scan and no extra search.
        if let Some(c) = best_plateau(w, player) {
            w.dist[player][c] = 0;
            w.queue[tail] = c as u32;
            tail += 1;
        }
        for s in &w.settlements {
            if !s.alive() || s.owner as usize != player {
                continue;
            }
            let c = idx(s.face as usize, s.x as usize, s.y as usize);
            if w.dist[player][c] == UNREACHED {
                w.dist[player][c] = 0;
                w.queue[tail] = c as u32;
                tail += 1;
            }
        }
    }

    while head < tail {
        let c = w.queue[head] as usize;
        head += 1;
        let d = w.dist[player][c];
        if d == UNREACHED {
            continue;
        }
        for dir in 0..4usize {
            let n = live_neighbour(c, dir);
            if !w.passable(n) || w.dist[player][n] != UNREACHED {
                continue;
            }
            w.dist[player][n] = d.saturating_add(1);
            // The direction stored at `n` is the one that walks *back* towards
            // the target. Crossing a seam rotates the heading, so it is the
            // reverse of the heading as seen from `n`, not of `dir`.
            let back = opposite(seam_heading(c, dir));
            w.flow[player][n] = back as u8;
            w.queue[tail] = n as u32;
            tail += 1;
        }
    }
}

/// The heading, in the destination cell's frame, of a step `dir` out of `c`.
#[inline]
fn seam_heading(c: usize, dir: usize) -> usize {
    let (face, x, y) = crate::world::decode(c);
    crate::seams::step(face, x, y, dir).3
}

/// The buildable cell with the largest equal-height plateau under this player's
/// influence, ties broken by flat index so the choice is total.
fn best_plateau(w: &World, player: usize) -> Option<usize> {
    let mut best: Option<(u8, usize)> = None;
    for face in 0..6usize {
        for y in 0..crate::world::N {
            for x in 0..crate::world::N {
                let c = idx(face, x, y);
                let size = w.plateau[c];
                if size < 3 || !w.passable(c) {
                    continue;
                }
                let infl = i32::from(w.influence[c]);
                let mine = if player == 0 { infl > 0 } else { infl < 0 };
                if !mine {
                    continue;
                }
                match best {
                    // Strictly greater, so the earliest flat index wins a tie.
                    Some((bs, _)) if size <= bs => {}
                    _ => best = Some((size, c)),
                }
            }
        }
    }
    best.map(|(_, c)| c)
}

/// Maximum contribution a single settlement can project (§4.5).
pub const MAX_CONTRIBUTION: i32 = 7 * INFLUENCE_REACH;

/// Project influence outward from settlements over the BFS graph.
///
/// Runs on the same 15-tick boundary as the flow field, and for the same reason.
///
/// Implemented as a monotone bucket BFS: contributions decrease by exactly one
/// per cell, so processing levels from `MAX_CONTRIBUTION` down to 1 visits every
/// cell at most once and yields the same answer as one Dijkstra per settlement,
/// at a fraction of the cost.
pub fn project(w: &mut World) {
    for player in 0..PLAYERS {
        project_for(w, player);
    }

    // Influence is zero-sum (§4.5). A cell belongs to one god or the other, and
    // gaining influence necessarily means taking it — which is what preserves
    // the anti-snowball property of §4.6.
    for face in 0..6usize {
        for y in 0..crate::world::N {
            for x in 0..crate::world::N {
                let c = idx(face, x, y);
                let a = i32::from(w.infl_acc[0][c]);
                let b = i32::from(w.infl_acc[1][c]);
                w.influence[c] = (a - b).clamp(-127, 127) as i8;
            }
        }
    }
}

fn project_for(w: &mut World, player: usize) {
    w.infl_acc[player].fill(0);
    let mut lo = 0usize;
    let mut hi = 0usize;

    for v in (1..=MAX_CONTRIBUTION).rev() {
        // Seed any settlement whose contribution starts exactly at this level.
        // Settlements are visited in slot order, which is fixed.
        for s in &w.settlements {
            if !s.alive() || s.owner as usize != player {
                continue;
            }
            let contribution = i32::from(TIER_STRENGTH[s.tier as usize]) * INFLUENCE_REACH;
            if contribution != v {
                continue;
            }
            let c = idx(s.face as usize, s.x as usize, s.y as usize);
            if i32::from(w.infl_acc[player][c]) < v {
                w.infl_acc[player][c] = v as i16;
                w.queue[hi] = c as u32;
                hi += 1;
            }
        }

        // Everything queued in `lo..end` sits at exactly this level.
        let end = hi;
        let next = v - 1;
        if next > 0 {
            for i in lo..end {
                let c = w.queue[i] as usize;
                for dir in 0..4usize {
                    let n = live_neighbour(c, dir);
                    if !w.passable(n) {
                        continue;
                    }
                    if i32::from(w.infl_acc[player][n]) >= next {
                        continue;
                    }
                    w.infl_acc[player][n] = next as i16;
                    w.queue[hi] = n as u32;
                    hi += 1;
                }
            }
        }
        lo = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seams::{DIR_DX, DIR_DY};
    use crate::world::{MAT_SOIL, MapConfig, N, SETTLE_ALIVE, Settlement, TERRAIN_PANGAEA, decode};

    fn island() -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = 77;
        let mut w = World::boxed();
        w.init(&cfg);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 400;
                    w.water[c] = 0;
                    w.lava[c] = 0;
                    w.material[c] = MAT_SOIL;
                }
            }
        }
        w.ghost_copy_all();
        // `init` seeds a settlement per player; clear them so each test states
        // its own starting position and nothing is inherited.
        for s in &mut w.settlements {
            *s = Settlement::default();
        }
        w.settle_of.fill(crate::world::NO_SETTLEMENT);
        w.settlement_count = 0;
        w
    }

    #[test]
    fn flow_field_points_downhill_in_distance_towards_the_magnet() {
        let mut w = island();
        w.magnet[0] =
            crate::world::Magnet { face: 4, x: 32, y: 32, active: 1, leader: u16::MAX, _pad: 0 };
        rebuild(&mut w);

        let target = idx(4, 32, 32);
        assert_eq!(w.dist[0][target], 0);

        // Following the field from anywhere must strictly reduce the distance
        // and terminate at the target.
        for &start in &[idx(4, 3, 3), idx(0, 10, 40), idx(1, 55, 5), idx(3, 20, 61)] {
            let mut c = start;
            let mut guard = 0;
            while c != target {
                let dir = w.flow[0][c];
                assert_ne!(dir, NO_FLOW, "flow field has a hole at {c}");
                let n = live_neighbour(c, dir as usize);
                assert!(w.dist[0][n] < w.dist[0][c], "flow field does not descend at {c}");
                c = n;
                guard += 1;
                assert!(guard < 4 * N * 6, "flow field walk did not terminate");
            }
        }
    }

    #[test]
    fn flow_field_directions_survive_a_seam_crossing() {
        // The stored direction is expressed in the *storing* cell's frame. If
        // the seam rotation were dropped, walkers would turn a corner every time
        // they crossed a face boundary — visible as a permanent traffic jam at
        // seams and nowhere else.
        let mut w = island();
        w.magnet[0] =
            crate::world::Magnet { face: 0, x: 32, y: 32, active: 1, leader: u16::MAX, _pad: 0 };
        rebuild(&mut w);

        for face in 0..6usize {
            for t in (0..N).step_by(5) {
                for edge in 0..4usize {
                    let (x, y) = match edge {
                        0 => (t, N - 1),
                        1 => (N - 1, t),
                        2 => (t, 0),
                        _ => (0, t),
                    };
                    let c = idx(face, x, y);
                    let dir = w.flow[0][c];
                    if dir == NO_FLOW {
                        continue;
                    }
                    let n = live_neighbour(c, dir as usize);
                    assert!(
                        w.dist[0][n] < w.dist[0][c],
                        "edge cell ({face},{x},{y}) points uphill after a seam crossing"
                    );
                    // The step must be to a genuine 4-neighbour.
                    let (nf, nx, ny) = decode(n);
                    let same_face_step =
                        nf == face && (nx - x as i32).abs() + (ny - y as i32).abs() == 1;
                    let crossed = nf != face;
                    assert!(same_face_step || crossed);
                    let _ = (DIR_DX[dir as usize], DIR_DY[dir as usize]);
                }
            }
        }
    }

    #[test]
    fn impassable_cells_are_never_entered() {
        let mut w = island();
        // A moat of deep water across face 4.
        for x in 0..N {
            let c = idx(4, x, 20);
            w.height[c] = -400;
            w.water[c] = 800;
        }
        w.ghost_copy_all();
        w.magnet[0] =
            crate::world::Magnet { face: 4, x: 32, y: 10, active: 1, leader: u16::MAX, _pad: 0 };
        rebuild(&mut w);
        for x in 0..N {
            let c = idx(4, x, 20);
            assert_eq!(w.dist[0][c], UNREACHED, "BFS walked into deep water");
            assert_eq!(w.flow[0][c], NO_FLOW);
        }
    }

    #[test]
    fn influence_is_zero_sum_and_decays_with_distance() {
        let mut w = island();
        w.settlements[0] = Settlement {
            progress: 1000,
            face: 4,
            x: 20,
            y: 32,
            size: 9,
            tier: 4,
            owner: 0,
            pop: 0,
            flags: SETTLE_ALIVE,
        };
        w.settlements[1] = Settlement {
            progress: 1000,
            face: 4,
            x: 44,
            y: 32,
            size: 9,
            tier: 4,
            owner: 1,
            pop: 0,
            flags: SETTLE_ALIVE,
        };
        project(&mut w);

        assert!(w.influence[idx(4, 20, 32)] > 0, "player 0's own centre is not theirs");
        assert!(w.influence[idx(4, 44, 32)] < 0, "player 1's own centre is not theirs");

        // Strictly decaying with distance along the line between them.
        let mut last = i32::from(w.influence[idx(4, 20, 32)]);
        for d in 1..10 {
            let v = i32::from(w.influence[idx(4, 20 + d, 32)]);
            assert!(v <= last, "influence did not decay at distance {d}");
            last = v;
        }

        // Exactly halfway between two identical settlements it must cancel.
        assert_eq!(w.influence[idx(4, 32, 32)], 0, "the midpoint is not neutral");

        // Out of reach of everything, nobody owns anything.
        assert_eq!(w.influence[idx(1, 32, 32)], 0);
    }

    #[test]
    fn a_bigger_settlement_projects_further() {
        let mut w = island();
        w.settlements[0] = Settlement {
            progress: 1000,
            face: 4,
            x: 16,
            y: 16,
            size: 3,
            tier: 1,
            owner: 0,
            pop: 0,
            flags: SETTLE_ALIVE,
        };
        project(&mut w);
        let hut_reach = (0..N).filter(|&x| w.influence[idx(4, x, 16)] > 0).count();

        w.settlements[0].tier = 4;
        w.settlements[0].size = 9;
        project(&mut w);
        let citadel_reach = (0..N).filter(|&x| w.influence[idx(4, x, 16)] > 0).count();

        assert!(
            citadel_reach > hut_reach * 3,
            "tier strength does not drive reach (hut {hut_reach}, citadel {citadel_reach})"
        );
    }

    #[test]
    fn projection_is_independent_of_settlement_slot_order() {
        let make = |slot_a: usize, slot_b: usize| {
            let mut w = island();
            w.settlements[slot_a] = Settlement {
                progress: 1000,
                face: 4,
                x: 20,
                y: 20,
                size: 7,
                tier: 3,
                owner: 0,
                pop: 0,
                flags: SETTLE_ALIVE,
            };
            w.settlements[slot_b] = Settlement {
                progress: 1000,
                face: 4,
                x: 40,
                y: 40,
                size: 5,
                tier: 2,
                owner: 0,
                pop: 0,
                flags: SETTLE_ALIVE,
            };
            project(&mut w);
            let mut acc = 0i64;
            for face in 0..6usize {
                for y in 0..N {
                    for x in 0..N {
                        acc = acc * 3 + i64::from(w.influence[idx(face, x, y)]);
                        acc &= 0x7FFF_FFFF_FFFF;
                    }
                }
            }
            acc
        };
        assert_eq!(make(0, 1), make(9, 3), "influence depends on which slots were used");
    }
}
