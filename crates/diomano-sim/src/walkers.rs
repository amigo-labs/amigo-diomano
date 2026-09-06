//! Walkers: spawning, movement and seam crossing. HANDOFF §4.5.
//!
//! Walkers store `(face, x: Q16.16, y: Q16.16, strength, hp)` and follow the
//! flow-field gradient. Crossing a seam applies the §3.3 transform — including
//! the sub-cell offset, so a walker does not visibly jump when it changes face.
//!
//! **Walker animation is purely cosmetic and must never feed back into
//! simulation state** (§4.5). Nothing here knows about a walking figure; it
//! moves a point.

use crate::fixed::{Fx, ONE};
use crate::seams::{Axis, DIR_DX, DIR_DY, DIR_E, DIR_N, DIR_S, DIR_W, SEAM};
use crate::world::{
    N, NO_FLOW, NO_SETTLEMENT, PLAYERS, WALKER_ALIVE, WALKER_CHAMPION, WALKER_LEADER, Walker,
    World, idx,
};

/// Cells per tick. `[START]` 1/16 of a cell, i.e. ~1.9 cells per second.
pub const SPEED: Fx = ONE / 16;

/// Face extent in Q16.16.
const EXTENT: Fx = (N as Fx) << 16;

/// Walker slots alternate between players, so walker ids interleave.
///
/// Combat resolves within a cell in id order (§4.7). If player 0 owned the whole
/// low half of the id space it would always act first in every contested cell —
/// deterministic, but a systematic advantage baked into an array layout.
#[inline]
#[must_use]
pub const fn slot_of(player: usize, n: usize) -> usize {
    n * PLAYERS + player
}

/// Create a walker. Returns its id, or `None` if the player is at cap.
pub fn spawn(
    w: &mut World,
    player: usize,
    face: usize,
    x: usize,
    y: usize,
    strength: u8,
    home: u16,
) -> Option<u16> {
    let mut slot = None;
    for n in 0..crate::world::WALKERS_PER_PLAYER {
        let s = slot_of(player, n);
        if !w.walkers[s].alive() {
            slot = Some(s);
            break;
        }
    }
    let slot = slot?;
    let strength = strength.max(1);
    w.walkers[slot] = Walker {
        // Cell centre, so a freshly spawned walker is not sitting on a boundary.
        x: ((x as Fx) << 16) + ONE / 2,
        y: ((y as Fx) << 16) + ONE / 2,
        hp: i16::from(strength) * 16,
        id: slot as u16,
        home,
        face: face as u8,
        owner: player as u8,
        strength,
        flags: WALKER_ALIVE,
        pop_carried: 0,
    };
    w.walker_count[player] = w.walker_count[player].saturating_add(1);
    Some(slot as u16)
}

/// Remove a walker and give every population slot it held back.
///
/// Its own slot goes to its home. The slots it carries from walkers it absorbed
/// (`pop_carried`) came from settlements the model no longer knows — a merged
/// walker is one unit — so each goes to the owner's living settlement with the
/// most population out, ties to the lowest slot. Deterministic, no new state, and
/// no settlement stays starved: crediting all of them to `home` used to leave
/// the settlements the absorbed walkers came from at their cap for good, with
/// `spawn_population` skipping them until the match ended. A 20,000-tick match
/// finished with fifteen settlements fielding two walkers per player.
pub fn remove(w: &mut World, id: usize) {
    if !w.walkers[id].alive() {
        return;
    }
    let wk = w.walkers[id];
    let owner = (wk.owner as usize) % PLAYERS;
    w.walker_count[owner] = w.walker_count[owner].saturating_sub(1);
    if wk.home != NO_SETTLEMENT {
        let home = wk.home as usize;
        if home < w.settlements.len() && w.settlements[home].alive() {
            w.settlements[home].pop = w.settlements[home].pop.saturating_sub(1);
        }
    }
    for _ in 0..wk.pop_carried {
        let fullest = (0..w.settlements.len())
            .filter(|&s| {
                let st = &w.settlements[s];
                st.alive() && st.owner as usize == owner && st.pop > 0
            })
            .max_by_key(|&s| (w.settlements[s].pop, core::cmp::Reverse(s)));
        let Some(slot) = fullest else {
            break; // nobody has anyone out: the slot was already lost with its settlement
        };
        w.settlements[slot].pop -= 1;
    }
    // Only the magnet's *current* leader drops it. The flag alone is not enough:
    // it is a cache of `magnet.leader`, and a walker whose magnet was re-placed
    // must not drag the new placement to wherever it later falls.
    if wk.flags & WALKER_LEADER != 0 && w.magnet[owner].leader == id as u16 {
        // "If the leader dies the magnet drops there" (§5.1).
        let p = owner;
        w.magnet[p].active = 1;
        w.magnet[p].face = wk.face;
        w.magnet[p].x = crate::fixed::floor_int(wk.x).clamp(0, N as i32 - 1) as u8;
        w.magnet[p].y = crate::fixed::floor_int(wk.y).clamp(0, N as i32 - 1) as u8;
        w.magnet[p].leader = u16::MAX;
    }
    w.walkers[id] = Walker { home: NO_SETTLEMENT, ..Walker::default() };
}

/// Walker movement (§4.1 pass 8), in fixed walker-id order.
pub fn movement(w: &mut World) {
    for id in 0..w.walkers.len() {
        if !w.walkers[id].alive() {
            continue;
        }
        step_walker(w, id);
    }
}

fn step_walker(w: &mut World, id: usize) {
    let wk = w.walkers[id];
    let owner = (wk.owner as usize) % PLAYERS;
    let face = wk.face as usize;
    let cx = crate::fixed::floor_int(wk.x).clamp(0, N as i32 - 1);
    let cy = crate::fixed::floor_int(wk.y).clamp(0, N as i32 - 1);
    let here = idx(face, cx as usize, cy as usize);

    // A champion seeks enemy settlements (§4.7). It does that by following the
    // *opponent's* flow field, which already points at exactly those targets —
    // no second search, no special-cased pathfinder.
    let field = if wk.flags & WALKER_CHAMPION != 0 { 1 - owner } else { owner };
    let dir = w.flow[field][here];
    if dir == NO_FLOW || dir as usize >= 4 {
        // Standing still — possibly *on* the magnet, whose own cell carries no
        // flow direction. A walker already there when the magnet lands on it
        // never moves and, without this, never became its leader.
        claim_magnet(w, id, owner, face, cx, cy);
        return;
    }
    let dir = dir as usize;

    let nx = wk.x + DIR_DX[dir] * SPEED;
    let ny = wk.y + DIR_DY[dir] * SPEED;

    let leaving = !(0..EXTENT).contains(&nx) || !(0..EXTENT).contains(&ny);
    let (nface, nx, ny) = if leaving { cross_seam(face, nx, ny, dir) } else { (face, nx, ny) };

    let dcx = crate::fixed::floor_int(nx).clamp(0, N as i32 - 1);
    let dcy = crate::fixed::floor_int(ny).clamp(0, N as i32 - 1);
    let dest = idx(nface, dcx as usize, dcy as usize);

    if !w.passable(dest) {
        return;
    }
    // "Never leave own influence" without a magnet (§4.5). The magnet is the only
    // way to expand beyond it, which is what makes expansion a deliberate act.
    if wk.flags & (WALKER_CHAMPION | WALKER_LEADER) == 0 && w.magnet[owner].active == 0 {
        let infl = i32::from(w.influence[dest]);
        let mine = if owner == 0 { infl >= 0 } else { infl <= 0 };
        if !mine {
            return;
        }
    }

    w.walkers[id].face = nface as u8;
    w.walkers[id].x = nx;
    w.walkers[id].y = ny;

    claim_magnet(w, id, owner, nface, dcx, dcy);
}

/// First walker to reach the magnet becomes leader (§5.1).
///
/// Never a champion. `make_champion` moves the magnet onto the champion and
/// drops the leader on purpose — "the player has no leader until a walker
/// touches the magnet again" — and a champion standing on that cell would
/// otherwise claim it back on the next pass, arriving at LEADER | CHAMPION:
/// tripled strength plus the holy fire's invincibility, with nobody else able
/// to claim the magnet while it lives.
fn claim_magnet(w: &mut World, id: usize, owner: usize, face: usize, x: i32, y: i32) {
    if w.walkers[id].flags & WALKER_CHAMPION != 0 {
        return;
    }
    let m = w.magnet[owner];
    if m.active == 0 || m.leader != u16::MAX {
        return;
    }
    if m.face as usize != face || i32::from(m.x) != x || i32::from(m.y) != y {
        return;
    }
    w.magnet[owner].leader = id as u16;
    w.walkers[id].flags |= WALKER_LEADER;
}

/// Move a Q16.16 position across a face boundary, carrying the sub-cell offset.
///
/// Snapping to the destination cell centre would be simpler and would show up as
/// a visible twitch every time a walker changes face — rare, but exactly the
/// kind of artefact that reads as a seam bug.
fn cross_seam(face: usize, nx: Fx, ny: Fx, dir: usize) -> (usize, Fx, Fx) {
    let rule = SEAM[face * 4 + dir];

    // How far past the boundary the step landed, in `0..SPEED`.
    let overshoot = match dir {
        DIR_E => nx - EXTENT,
        DIR_W => -nx,
        DIR_N => ny - EXTENT,
        _ => -ny,
    }
    .clamp(0, ONE - 1);

    // The coordinate running along the edge we left through.
    let t = if dir == DIR_N || dir == DIR_S { nx } else { ny }.clamp(0, EXTENT - 1);
    // A flip reverses cell `i` to `N - 1 - i`. For a continuous coordinate the
    // mirror is `EXTENT - 1 - t`, one ulp short of `EXTENT - t`: cell `i` is the
    // half-open interval `[i, i + 1)`, and `EXTENT - t` maps its *start* to the
    // start of cell `N - i` — one cell past the seam table's answer. Positions
    // live on a `SPEED` lattice, so "exactly at the start" is a routine case,
    // not a rounding curiosity.
    let mapped = if rule.flip { EXTENT - 1 - t } else { t };
    let entry = if rule.at_max { EXTENT - 1 - overshoot } else { overshoot };

    let (x, y) = match rule.axis {
        Axis::X => (mapped, entry),
        Axis::Y => (entry, mapped),
    };
    (rule.face as usize, x.clamp(0, EXTENT - 1), y.clamp(0, EXTENT - 1))
}

/// Promote a walker to champion (§4.7).
///
/// The magnet transfers to the champion, so the player has no leader until a
/// walker touches the magnet again.
pub fn make_champion(w: &mut World, player: usize) -> bool {
    // Never re-promote a walker that is already a champion. The promotion below
    // *triples* strength, so casting the verb twice on the same walker compounded
    // it: a scripted 20,000-tick match drove one walker to 2 → 6 → 18 → 54 → 162 →
    // 255, straight past `MERGE_MAX_STRENGTH` and every other bound in the game.
    // A second cast promotes a second walker, or does nothing.
    let leader = w.magnet[player].leader;
    let promotable =
        |k: &Walker| k.alive() && k.owner as usize == player && k.flags & WALKER_CHAMPION == 0;
    let id = if leader != u16::MAX
        && (leader as usize) < w.walkers.len()
        && promotable(&w.walkers[leader as usize])
    {
        leader as usize
    } else {
        // No usable leader: the lowest-id living walker steps up, so the choice is
        // a function of state rather than of whoever happened to be scanned first.
        let Some(id) = w.walkers.iter().position(promotable) else {
            return false;
        };
        id
    };
    // The magnet transfers to the champion, so whoever led it stops leading —
    // including a leader that was not promotable and is therefore not `id`.
    if leader != u16::MAX && (leader as usize) < w.walkers.len() {
        w.walkers[leader as usize].flags &= !WALKER_LEADER;
    }
    let wk = w.walkers[id];
    w.walkers[id].flags = (wk.flags | WALKER_CHAMPION) & !WALKER_LEADER;
    w.walkers[id].strength = wk.strength.saturating_mul(3).max(6);
    w.walkers[id].hp = i16::from(w.walkers[id].strength) * 16;
    w.magnet[player].face = wk.face;
    w.magnet[player].x = crate::fixed::floor_int(wk.x).clamp(0, N as i32 - 1) as u8;
    w.magnet[player].y = crate::fixed::floor_int(wk.y).clamp(0, N as i32 - 1) as u8;
    w.magnet[player].leader = u16::MAX;
    true
}

/// The cell a walker occupies.
#[inline]
#[must_use]
pub fn cell_of(wk: &Walker) -> usize {
    let x = crate::fixed::floor_int(wk.x).clamp(0, N as i32 - 1);
    let y = crate::fixed::floor_int(wk.y).clamp(0, N as i32 - 1);
    idx(wk.face as usize, x as usize, y as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seams::step;
    use crate::world::{MAT_SOIL, Magnet, MapConfig, TERRAIN_PANGAEA};

    fn open_world() -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = 404;
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
                    w.influence[c] = 0;
                }
            }
        }
        w.ghost_copy_all();
        for k in &mut w.walkers {
            *k = Walker::default();
        }
        w.walker_count = [0; PLAYERS];
        w
    }

    #[test]
    fn slots_interleave_so_neither_player_owns_the_low_ids() {
        for n in 0..4 {
            assert_eq!(slot_of(0, n) % 2, 0);
            assert_eq!(slot_of(1, n) % 2, 1);
        }
        assert!(slot_of(1, 0) < slot_of(0, 1), "player 1 has no low ids at all");
    }

    #[test]
    fn a_walker_follows_the_magnet_across_a_seam_without_teleporting() {
        let mut w = open_world();
        w.magnet[0] = Magnet { face: 5, x: 32, y: 32, active: 1, leader: u16::MAX, _pad: 0 };
        crate::flowfield::rebuild(&mut w);

        // Start near the +x/-z boundary, which is a seam that preserves heading.
        let id = spawn(&mut w, 0, 0, 60, 30, 2, NO_SETTLEMENT).unwrap() as usize;

        let mut faces_seen = std::collections::BTreeSet::new();
        let mut prev = (w.walkers[id].face, w.walkers[id].x, w.walkers[id].y);
        for t in 0..4000 {
            movement(&mut w);
            let now = (w.walkers[id].face, w.walkers[id].x, w.walkers[id].y);
            faces_seen.insert(now.0);
            if now.0 == prev.0 {
                let jump = (now.1 - prev.1).abs().max((now.2 - prev.2).abs());
                assert!(jump <= SPEED, "walker jumped {jump} at tick {t} inside a face");
            }
            prev = now;
            if cell_of(&w.walkers[id]) == idx(5, 32, 32) {
                break;
            }
        }
        assert!(faces_seen.len() >= 2, "walker never left its starting face");
        assert_eq!(cell_of(&w.walkers[id]), idx(5, 32, 32), "walker never reached the magnet");
        assert_ne!(w.magnet[0].leader, u16::MAX, "reaching the magnet did not make a leader");
    }

    #[test]
    fn seam_crossing_lands_where_the_seam_table_says_it_should() {
        // Every sub-cell offset the along-edge coordinate can have, including
        // exactly the cell's start: the first version of this test probed only
        // the centre, which is the one offset at which the old `EXTENT - t`
        // mirror happened to agree with the seam table.
        for frac in [0, ONE / 16, ONE / 2, ONE - 1] {
            for face in 0..6usize {
                for dir in 0..4usize {
                    for t in [0i32, 7, 31, 63] {
                        // Position just past the edge in `dir`.
                        let along = (t << 16) + frac;
                        let (px, py) = match dir {
                            DIR_N => (along, EXTENT + ONE / 4),
                            DIR_E => (EXTENT + ONE / 4, along),
                            DIR_S => (along, -(ONE / 4)),
                            _ => (-(ONE / 4), along),
                        };
                        let (nf, nx, ny) = cross_seam(face, px, py, dir);
                        let (sf, sx, sy, _) = match dir {
                            DIR_N => step(face, t, N as i32 - 1, dir),
                            DIR_E => step(face, N as i32 - 1, t, dir),
                            DIR_S => step(face, t, 0, dir),
                            _ => step(face, 0, t, dir),
                        };
                        assert_eq!(nf, sf, "face mismatch for ({face},{dir},{t}+{frac})");
                        assert_eq!(
                            (crate::fixed::floor_int(nx), crate::fixed::floor_int(ny)),
                            (sx, sy),
                            "cell mismatch for ({face},{dir},{t}+{frac})"
                        );
                        assert!((0..EXTENT).contains(&nx) && (0..EXTENT).contains(&ny));
                    }
                }
            }
        }
    }

    /// Re-placing the magnet retires its leader, all the way down to the flag
    /// on the walker. With only `magnet.leader` reset, the old leader kept its
    /// flag, and `remove` — "if the leader dies the magnet drops there" — later
    /// moved the player's *new* magnet to wherever that walker happened to die.
    #[test]
    fn a_replaced_magnet_retires_the_old_leader() {
        let mut w = open_world();
        w.mana[0] = 1_000 << 16;
        let id = spawn(&mut w, 0, 2, 20, 20, 2, NO_SETTLEMENT).unwrap() as usize;
        let place = |w: &mut World, x: u16, y: u16| {
            let cmd = crate::world::Command {
                tick: 0,
                x,
                y,
                player: 0,
                verb: crate::world::VERB_MAGNET,
                face: 2,
                modifier: 0,
            };
            crate::powers::apply(w, 0, &cmd);
        };

        // The magnet lands on the walker's own cell; standing there is enough to
        // claim it (the target cell has no flow direction, so it never moves).
        place(&mut w, 20, 20);
        movement(&mut w);
        assert_eq!(w.magnet[0].leader, id as u16, "a walker on the magnet did not claim it");
        assert_ne!(w.walkers[id].flags & WALKER_LEADER, 0);

        // The player moves on.
        place(&mut w, 40, 40);
        assert_eq!(w.magnet[0].leader, u16::MAX);
        assert_eq!(w.walkers[id].flags & WALKER_LEADER, 0, "the old leader kept its flag");

        // Its death must leave the new placement alone.
        remove(&mut w, id);
        assert_eq!(
            (w.magnet[0].face, w.magnet[0].x, w.magnet[0].y),
            (2, 40, 40),
            "a retired leader dragged the magnet to where it died"
        );
        assert_eq!(w.magnet[0].active, 1);
    }

    /// The belt to that fix's braces: even with a stale flag, `remove` consults
    /// the magnet's own idea of who leads before moving it.
    #[test]
    fn only_the_magnets_current_leader_drops_it_on_death() {
        let mut w = open_world();
        w.magnet[0] = Magnet { face: 2, x: 10, y: 10, active: 1, leader: u16::MAX, _pad: 0 };
        let id = spawn(&mut w, 0, 2, 20, 20, 2, NO_SETTLEMENT).unwrap() as usize;
        w.walkers[id].flags |= WALKER_LEADER; // stale: the magnet does not know it
        remove(&mut w, id);
        assert_eq!((w.magnet[0].face, w.magnet[0].x, w.magnet[0].y), (2, 10, 10));
    }

    #[test]
    fn a_dead_walker_returns_carried_people_to_the_settlement_with_most_out() {
        let mut w = open_world();
        for s in &mut w.settlements {
            s.pop = 0;
        }
        // Home has this one walker charged; a second settlement has two out,
        // absorbed into this walker long ago.
        let town = |x: u8, pop: u8| crate::world::Settlement {
            progress: 100,
            face: 4,
            x,
            y: 20,
            size: 3,
            tier: 1,
            owner: 0,
            pop,
            flags: crate::world::SETTLE_ALIVE,
        };
        w.settlements[0] = town(20, 1);
        w.settlements[1] = town(40, 2);
        let id = spawn(&mut w, 0, 4, 30, 30, 2, 0).unwrap() as usize;
        w.walkers[id].pop_carried = 2;
        remove(&mut w, id);
        assert_eq!(w.settlements[0].pop, 0, "the walker's own slot did not go home");
        assert_eq!(
            w.settlements[1].pop, 0,
            "the carried slots did not go back to the settlement that fielded them"
        );
    }

    #[test]
    fn walkers_stay_inside_their_own_influence_without_a_magnet() {
        let mut w = open_world();
        // Player 0 owns the left half of face 4 only.
        for y in 0..N {
            for x in 0..N {
                w.influence[idx(4, x, y)] = if x < 32 { 60 } else { -60 };
            }
        }
        w.ghost_copy_all();
        // A flow field pointing east, straight at the enemy half.
        w.flow[0].fill(crate::seams::DIR_E as u8);

        let id = spawn(&mut w, 0, 4, 30, 30, 2, NO_SETTLEMENT).unwrap() as usize;
        for _ in 0..2000 {
            movement(&mut w);
        }
        let x = crate::fixed::floor_int(w.walkers[id].x);
        assert!(x < 32, "walker left its own influence with no magnet placed (x = {x})");

        // With a magnet, the same walker may cross. The magnet is the only way to
        // expand beyond your influence (§4.5).
        w.magnet[0] = Magnet { face: 4, x: 60, y: 30, active: 1, leader: u16::MAX, _pad: 0 };
        crate::flowfield::rebuild(&mut w);
        for _ in 0..4000 {
            movement(&mut w);
        }
        let x = crate::fixed::floor_int(w.walkers[id].x);
        assert!(x >= 32, "the magnet did not let the walker expand (x = {x})");
    }

    #[test]
    fn walkers_never_enter_impassable_cells() {
        let mut w = open_world();
        for y in 0..N {
            let c = idx(4, 40, y);
            w.height[c] = -500;
            w.water[c] = 900;
        }
        w.ghost_copy_all();
        w.flow[0].fill(crate::seams::DIR_E as u8);
        let id = spawn(&mut w, 0, 4, 30, 30, 2, NO_SETTLEMENT).unwrap() as usize;
        for _ in 0..3000 {
            movement(&mut w);
        }
        assert!(crate::fixed::floor_int(w.walkers[id].x) < 40, "walker walked into the sea");
    }

    #[test]
    fn a_dying_leader_drops_the_magnet_where_it_fell() {
        let mut w = open_world();
        w.magnet[0] = Magnet { face: 2, x: 10, y: 10, active: 1, leader: u16::MAX, _pad: 0 };
        let id = spawn(&mut w, 0, 2, 20, 20, 2, NO_SETTLEMENT).unwrap() as usize;
        w.walkers[id].flags |= WALKER_LEADER;
        w.magnet[0].leader = id as u16;
        remove(&mut w, id);
        assert_eq!(w.magnet[0].active, 1);
        assert_eq!((w.magnet[0].face, w.magnet[0].x, w.magnet[0].y), (2, 20, 20));
        assert_eq!(w.magnet[0].leader, u16::MAX);
    }

    #[test]
    fn a_champion_walks_towards_the_enemy() {
        let mut w = open_world();
        // Player 1's only target is far away on face 5.
        w.magnet[1] = Magnet { face: 5, x: 32, y: 32, active: 1, leader: u16::MAX, _pad: 0 };
        crate::flowfield::rebuild(&mut w);
        let id = spawn(&mut w, 0, 4, 32, 32, 2, NO_SETTLEMENT).unwrap() as usize;
        w.walkers[id].flags |= WALKER_CHAMPION;

        let start_face = w.walkers[id].face;
        let mut reached = false;
        for _ in 0..8000 {
            movement(&mut w);
            if cell_of(&w.walkers[id]) == idx(5, 32, 32) {
                reached = true;
                break;
            }
        }
        assert!(reached, "champion never reached the enemy (started on face {start_face})");
    }

    #[test]
    fn removing_a_walker_frees_its_settlement_population_slot() {
        let mut w = open_world();
        w.settlements[3] = crate::world::Settlement {
            progress: 300,
            face: 0,
            x: 5,
            y: 5,
            size: 5,
            tier: 2,
            owner: 0,
            pop: 4,
            flags: crate::world::SETTLE_ALIVE,
        };
        let id = spawn(&mut w, 0, 0, 5, 5, 2, 3).unwrap() as usize;
        assert_eq!(w.walker_count[0], 1);
        remove(&mut w, id);
        assert_eq!(w.walker_count[0], 0);
        assert_eq!(w.settlements[3].pop, 3);
    }

    #[test]
    fn the_walker_cap_is_respected() {
        let mut w = open_world();
        for _ in 0..crate::world::WALKERS_PER_PLAYER {
            assert!(spawn(&mut w, 1, 0, 4, 4, 1, NO_SETTLEMENT).is_some());
        }
        assert!(spawn(&mut w, 1, 0, 4, 4, 1, NO_SETTLEMENT).is_none(), "cap exceeded");
        assert_eq!(w.walker_count[1] as usize, crate::world::WALKERS_PER_PLAYER);
        // The other player is unaffected.
        assert!(spawn(&mut w, 0, 0, 4, 4, 1, NO_SETTLEMENT).is_some());
    }
}
