//! Autonomous walker combat. HANDOFF §4.7.
//!
//! Walkers fight on contact. The player never issues an attack order (pillar 3);
//! the player decides where the magnet is and what the terrain allows.
//!
//! # This is the highest-risk determinism site in the codebase
//!
//! §4.7 and §10 both say so, and §13 lists it third among the ways the project
//! dies — because it *will* pass casual testing and fail in a real match:
//! simultaneous multi-walker contacts are rare early and constant late.
//!
//! The order is therefore not "whatever the collision structure gives us":
//!
//! 1. Cells in fixed flat-index order (face, then y, then x).
//! 2. Within a cell, walkers sorted by walker id ascending.
//! 3. Resolve pairwise in that order.
//!
//! The sort in step 2 is free rather than trusted: walkers live in a slot array
//! indexed by id, the bucketing pass visits them in id order, and a counting
//! sort is stable — so every bucket comes out id-ascending by construction. No
//! comparator exists that could be written without a tiebreaker.

use crate::world::{CELLS, MAX_WALKERS, NO_SETTLEMENT, World};

/// Bucket every living walker by the cell it occupies.
///
/// Returns nothing; fills `cell_start` (segment offsets, flat-index order) and
/// `cell_count` (segment lengths) and `bucket` (walker ids).
fn bucket_walkers(w: &mut World) {
    w.cell_count.fill(0);
    for id in 0..MAX_WALKERS {
        if !w.walkers[id].alive() {
            continue;
        }
        let c = crate::walkers::cell_of(&w.walkers[id]);
        w.cell_count[c] = w.cell_count[c].saturating_add(1);
    }

    // Exclusive prefix sum, in flat-index order.
    let mut acc = 0u32;
    for c in 0..CELLS {
        w.cell_start[c] = acc;
        acc += u32::from(w.cell_count[c]);
    }

    // Refill, reusing `cell_count` as the per-cell write cursor. Walkers are
    // visited in id order, so each segment ends up id-ascending — which *is*
    // step 2 of §4.7, not an approximation of it.
    w.cell_count.fill(0);
    for id in 0..MAX_WALKERS {
        if !w.walkers[id].alive() {
            continue;
        }
        let c = crate::walkers::cell_of(&w.walkers[id]);
        let pos = (w.cell_start[c] + u32::from(w.cell_count[c])) as usize;
        w.bucket[pos] = id as u16;
        w.cell_count[c] += 1;
    }
}

/// Combat resolution (§4.1 pass 9).
pub fn resolve(w: &mut World) {
    bucket_walkers(w);
    fight(w);
    besiege(w);
    reap(w);
}

fn fight(w: &mut World) {
    // Step 1: cells in fixed flat-index order.
    for c in 0..CELLS {
        let n = w.cell_count[c] as usize;
        if n < 2 {
            continue;
        }
        let start = w.cell_start[c] as usize;
        // Step 3: pairwise, in the order step 2 established.
        for i in start..start + n {
            let a = w.bucket[i] as usize;
            if w.walkers[a].hp <= 0 {
                continue;
            }
            for j in i + 1..start + n {
                let b = w.bucket[j] as usize;
                if w.walkers[b].hp <= 0 || w.walkers[a].hp <= 0 {
                    continue;
                }
                if w.walkers[a].owner == w.walkers[b].owner {
                    continue;
                }
                // Each loses the opponent's strength per tick. Applied
                // simultaneously within the pair: reading both strengths before
                // writing either hp is what makes "the stronger survives with a
                // remainder" true rather than "whoever is listed first wins".
                let sa = i16::from(w.walkers[a].strength);
                let sb = i16::from(w.walkers[b].strength);
                w.walkers[a].hp -= sb;
                w.walkers[b].hp -= sa;
            }
        }
    }
}

/// Settlements fall gradually, never instantly (§4.7).
///
/// Gradual decay is required, not cosmetic: it creates the reaction window in
/// which the god can intervene with terrain — swamp the approach, reroute water,
/// cut the path, raise a wall. Instant destruction would leave nothing to
/// respond to, and pillar 3 would be hollow.
fn besiege(w: &mut World) {
    for id in 0..MAX_WALKERS {
        if !w.walkers[id].alive() || w.walkers[id].hp <= 0 {
            continue;
        }
        let c = crate::walkers::cell_of(&w.walkers[id]);
        let slot = w.settle_of[c];
        if slot == NO_SETTLEMENT {
            continue;
        }
        let slot = slot as usize;
        if !w.settlements[slot].alive() || w.settlements[slot].owner == w.walkers[id].owner {
            continue;
        }
        let damage = i32::from(w.walkers[id].strength);
        w.settlements[slot].progress -= damage;
    }
}

/// Remove the dead, in id order.
fn reap(w: &mut World) {
    for id in 0..MAX_WALKERS {
        if w.walkers[id].alive() && w.walkers[id].hp <= 0 {
            crate::walkers::remove(w, id);
        }
    }
}

/// Ticks a settlement of the given tier survives a single attacker of `strength`.
///
/// Exposed so the reaction-window property can be asserted rather than eyeballed.
#[must_use]
pub fn ticks_to_raze(tier: u8, attackers_strength: i32) -> i32 {
    if attackers_strength <= 0 {
        return i32::MAX;
    }
    let progress = crate::world::TIER_THRESHOLD[tier as usize];
    let floor = crate::world::TIER_THRESHOLD[1];
    // The settlement also rebuilds while under attack.
    let net = attackers_strength - crate::settlements::BUILD_RATE;
    if net <= 0 {
        return i32::MAX;
    }
    (progress - floor) / net + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{
        MAT_SOIL, MapConfig, N, PLAYERS, SETTLE_ALIVE, Settlement, TERRAIN_PANGAEA, TIER_THRESHOLD,
        WALKER_ALIVE, Walker, idx,
    };

    fn arena(seed: u32) -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = seed;
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
        for k in &mut w.walkers {
            *k = Walker::default();
        }
        w.walker_count = [0; PLAYERS];
        w
    }

    /// Place a walker directly in a slot, bypassing the spawner, so a test can
    /// control ids exactly.
    fn place(
        w: &mut World,
        slot: usize,
        owner: u8,
        face: usize,
        x: usize,
        y: usize,
        strength: u8,
        hp: i16,
    ) {
        w.walkers[slot] = Walker {
            x: ((x as i32) << 16) + 32768,
            y: ((y as i32) << 16) + 32768,
            hp,
            id: slot as u16,
            home: NO_SETTLEMENT,
            face: face as u8,
            owner,
            strength,
            flags: WALKER_ALIVE,
        };
        w.walker_count[owner as usize] += 1;
    }

    #[test]
    fn buckets_come_out_id_ascending_without_a_sort() {
        let mut w = arena(1);
        // Deliberately populate high slots before low ones would not matter —
        // what matters is that the bucket ends up ordered by id regardless.
        for &slot in &[9usize, 2, 7, 0, 5] {
            place(&mut w, slot, (slot % 2) as u8, 3, 11, 11, 2, 100);
        }
        bucket_walkers(&mut w);
        let c = idx(3, 11, 11);
        let start = w.cell_start[c] as usize;
        let n = w.cell_count[c] as usize;
        assert_eq!(n, 5);
        let ids: std::vec::Vec<u16> = (start..start + n).map(|i| w.bucket[i]).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "bucket is not id-ascending");
        assert_eq!(ids, std::vec![0, 2, 5, 7, 9]);
    }

    /// Pins §4.7 step 2 exactly. The scenario is deliberately order-sensitive:
    /// walker 0 dies partway through the pair list, so whether walker 1 has
    /// already been fought decides walker 1's final hp.
    #[test]
    fn pairs_resolve_in_ascending_id_order() {
        let mut w = arena(2);
        place(&mut w, 0, 0, 4, 20, 20, 5, 5); // dies during the pass
        place(&mut w, 1, 1, 4, 20, 20, 3, 20);
        place(&mut w, 3, 1, 4, 20, 20, 9, 20);
        resolve(&mut w);

        assert!(!w.walkers[0].alive(), "walker 0 should have died");
        assert_eq!(
            w.walkers[1].hp, 15,
            "walker 1 was not fought before walker 0 died — resolution is not id-ascending"
        );
        assert_eq!(w.walkers[3].hp, 15);

        // Swap the two defenders' ids: now walker 1 is the strong one, so the
        // weak defender is the one that never gets its turn.
        let mut w = arena(2);
        place(&mut w, 0, 0, 4, 20, 20, 5, 5);
        place(&mut w, 1, 1, 4, 20, 20, 9, 20);
        place(&mut w, 3, 1, 4, 20, 20, 3, 20);
        resolve(&mut w);
        assert!(!w.walkers[0].alive());
        assert_eq!(w.walkers[1].hp, 15);
        assert_eq!(w.walkers[3].hp, 20, "the later id took damage from a dead walker");
    }

    #[test]
    fn the_stronger_survives_with_a_remainder() {
        let mut w = arena(3);
        place(&mut w, 0, 0, 4, 8, 8, 7, 7 * 16);
        place(&mut w, 1, 1, 4, 8, 8, 2, 2 * 16);
        for _ in 0..40 {
            resolve(&mut w);
            if !w.walkers[1].alive() {
                break;
            }
        }
        assert!(!w.walkers[1].alive(), "the weaker walker survived");
        assert!(w.walkers[0].alive(), "the stronger walker did not survive");
        assert!(w.walkers[0].hp > 0 && w.walkers[0].hp < 7 * 16, "attrition was not meaningful");
    }

    #[test]
    fn friendly_walkers_never_fight() {
        let mut w = arena(4);
        for slot in [0usize, 2, 4, 6] {
            place(&mut w, slot, 0, 1, 5, 5, 4, 64);
        }
        resolve(&mut w);
        for slot in [0usize, 2, 4, 6] {
            assert_eq!(w.walkers[slot].hp, 64);
        }
    }

    #[test]
    fn combat_has_no_randomness() {
        // §4.7: "No randomness; if any is wanted later it must come from the
        // seeded sim PRNG only." Assert the PRNG is untouched by a full combat
        // resolution, so nobody can quietly reach for it.
        let mut w = arena(5);
        for i in 0..20usize {
            place(&mut w, i, (i % 2) as u8, 2, 30, 30, 3, 40);
        }
        let rng_before = w.rng;
        resolve(&mut w);
        assert_eq!(w.rng, rng_before, "combat advanced the simulation PRNG");
    }

    fn stress_scenario(seed: u32) -> u64 {
        let mut w = arena(seed);
        // 200 simultaneous contacts: 200 cells, each holding one walker from
        // each side, spread over all six faces so seam handling is exercised.
        let mut placed = 0usize;
        'outer: for face in 0..6usize {
            for k in 0..40usize {
                if placed >= 200 {
                    break 'outer;
                }
                let x = 4 + (k % 8) * 7;
                let y = 4 + (k / 8) * 11;
                place(&mut w, placed * 2, 0, face, x, y, 2 + (k % 5) as u8, 40 + (k % 7) as i16);
                place(
                    &mut w,
                    placed * 2 + 1,
                    1,
                    face,
                    x,
                    y,
                    1 + (k % 6) as u8,
                    30 + (k % 9) as i16,
                );
                placed += 1;
            }
        }
        assert_eq!(placed, 200, "the stress scenario did not reach 200 contacts");

        for _ in 0..60 {
            resolve(&mut w);
        }
        w.state_hash()
    }

    #[test]
    fn stress_200_simultaneous_contacts_is_deterministic() {
        let first = stress_scenario(0xC0FFEE);
        for run in 1..100 {
            assert_eq!(
                stress_scenario(0xC0FFEE),
                first,
                "combat diverged on run {run} of 100 from the same seed"
            );
        }

        // A hash that matches because nothing happened would prove nothing.
        let mut w = arena(0xC0FFEE);
        place(&mut w, 0, 0, 0, 10, 10, 3, 48);
        place(&mut w, 1, 1, 0, 10, 10, 3, 48);
        let before = w.state_hash();
        for _ in 0..60 {
            resolve(&mut w);
        }
        assert_ne!(w.state_hash(), before, "the stress harness is not actually fighting");
    }

    #[test]
    fn a_besieged_settlement_falls_slowly_enough_to_save() {
        // §4.7 DoD: "a settlement under attack takes long enough to fall that a
        // terrain response can save it". Put a number on "long enough": the god
        // needs seconds, not frames (pillar 2).
        let mut w = arena(6);
        w.settlements[0] = Settlement {
            progress: TIER_THRESHOLD[3],
            face: 4,
            x: 32,
            y: 32,
            size: 7,
            tier: 3,
            owner: 0,
            pop: 0,
            flags: SETTLE_ALIVE,
        };
        for dy in -3i32..=3 {
            for dx in -3i32..=3 {
                let c = idx(4, (32 + dx) as usize, (32 + dy) as usize);
                w.settle_of[c] = 0;
                w.height[c] = 400;
            }
        }
        // Three attackers standing in the footprint.
        for i in 0..3usize {
            place(&mut w, i * 2 + 1, 1, 4, 31 + i, 32, 4, 64);
        }

        let mut ticks = 0;
        while w.settlements[0].alive() && ticks < 10_000 {
            resolve(&mut w);
            crate::settlements::update(&mut w);
            ticks += 1;
        }
        assert!(!w.settlements[0].alive(), "the settlement never fell");
        assert!(
            ticks >= 30,
            "a fortress fell in {ticks} ticks ({} s) — there is no reaction window",
            ticks / 30
        );
        assert!(ticks <= 3000, "a fortress took {ticks} ticks to fall; sieges never end");
    }

    #[test]
    fn ticks_to_raze_is_monotonic_in_tier_and_strength() {
        assert!(ticks_to_raze(4, 6) > ticks_to_raze(2, 6), "a citadel is no tougher than a house");
        assert!(ticks_to_raze(3, 12) < ticks_to_raze(3, 6), "more attackers is not faster");
        assert_eq!(ticks_to_raze(3, 1), i32::MAX, "a lone weak attacker out-builds nothing");
    }

    #[test]
    fn dead_walkers_are_reaped_in_id_order_and_free_their_slots() {
        let mut w = arena(7);
        place(&mut w, 0, 0, 3, 3, 3, 9, 1);
        place(&mut w, 1, 1, 3, 3, 3, 9, 1);
        assert_eq!(w.walker_count, [1, 1]);
        resolve(&mut w);
        assert_eq!(w.walker_count, [0, 0]);
        assert!(!w.walkers[0].alive() && !w.walkers[1].alive());
    }
}
