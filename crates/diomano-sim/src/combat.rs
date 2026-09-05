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

use crate::world::{
    CELLS, MAX_WALKERS, MERGE_MAX_HP, MERGE_MAX_STRENGTH, NO_SETTLEMENT, PLAYERS, WALKER_CHAMPION,
    WALKER_LEADER, Walker, World, idx,
};

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
    merge(w);
    fight(w);
    besiege(w);
    reap(w);
}

/// Is this walker the leader, standing on its own papal magnet?
///
/// `balance-research` finding 5, TODO-7: "Leader at the magnet is invincible,
/// surrounded by blue holy fire" is the Populous II rule verbatim. Without it,
/// placing the magnet forward is strictly risky, so the magnet — the one
/// positional decision the player gets over their walkers — only ever argues for
/// caution. With it, a forward magnet is a defensible rally point and the
/// decision has two sides.
///
/// Invincibility suppresses only *incoming* damage. The leader still deals its
/// strength, which is what makes the holy fire a threat rather than a bunker.
fn leader_on_own_magnet(w: &World, wk: &Walker) -> bool {
    if wk.flags & WALKER_LEADER == 0 {
        return false;
    }
    let m = w.magnet[(wk.owner as usize) % PLAYERS];
    // The magnet's own idea of who leads, not only the walker's flag: the
    // holy fire belongs to the leader of *this* magnet, and a flag is a
    // cache of that fact rather than the fact itself.
    if m.active == 0 || m.leader != wk.id {
        return false;
    }
    crate::walkers::cell_of(wk) == idx(m.face as usize, m.x as usize, m.y as usize)
}

/// May this walker take part in a merge, on either side?
fn mergeable(wk: &Walker) -> bool {
    // A champion is a unit a verb was spent on (`walkers::make_champion`).
    // Merging it away — or letting it quietly eat the army — would make a power's
    // effect depend on where walkers happened to be standing.
    wk.alive() && wk.hp > 0 && wk.flags & WALKER_CHAMPION == 0
}

/// Friendly walkers sharing a cell combine into one stronger walker.
///
/// `balance-research` finding 7, TODO-8: "Any time two of your walkers bump into
/// each other, they combine to make one stronger walker" is the Populous rule.
/// It is what made the papal magnet a *stacking* tool — gather, combine, march —
/// and without it the manual's own advice had no analogue in diomano.
///
/// Runs after [`bucket_walkers`] and before [`fight`], as its own pass rather
/// than inline in `fight`: merging kills walkers, and `fight` iterates `w.bucket`
/// indices that would go stale underneath it.
///
/// Order is the §4.7 order, for the same reason combat uses it — cells in flat
/// index order, and id-ascending within a cell, which the bucket already
/// guarantees by construction.
fn merge(w: &mut World) {
    for c in 0..CELLS {
        let n = w.cell_count[c] as usize;
        if n < 2 {
            continue;
        }
        let start = w.cell_start[c] as usize;
        for i in start..start + n {
            let a = w.bucket[i] as usize;
            for j in i + 1..start + n {
                if !mergeable(&w.walkers[a]) {
                    // `a` was itself absorbed (by a leader at a higher id). It is
                    // gone; whoever took it will absorb the rest when the outer
                    // loop reaches them.
                    break;
                }
                let b = w.bucket[j] as usize;
                if !mergeable(&w.walkers[b]) || w.walkers[a].owner != w.walkers[b].owner {
                    continue;
                }
                // The leader always absorbs and is never absorbed. Not a
                // stylistic choice: `walkers::remove` drops the papal magnet when
                // the walker it removes is the leader (§5.1, "if the leader dies
                // the magnet drops there"), which is right for a death and wrong
                // for a merge. Keeping the leader on the absorbing side means
                // `magnet[p].leader` stays a valid id without teaching `remove`
                // about merging.
                let b_leads = w.walkers[b].flags & WALKER_LEADER != 0;
                let a_leads = w.walkers[a].flags & WALKER_LEADER != 0;
                let (keep, gone) = if b_leads && !a_leads { (b, a) } else { (a, b) };

                // A walker already at the cap cannot absorb any more.
                //
                // This is what keeps an army an army. Every walker follows the same
                // flow field to the same magnet, so without this they all end up in
                // one cell and fold into a *single* walker — measured: one walker
                // per player for a whole 20,000-tick match, with population growth
                // contributing nothing once that walker hit the cap. Stopping at
                // the cap instead means a bigger population fields more capped
                // walkers, which is what makes gathering worth doing (the original
                // rule's whole point) rather than a way to throw people away.
                if w.walkers[keep].strength >= MERGE_MAX_STRENGTH {
                    continue;
                }
                absorb(w, keep, gone);
            }
        }
    }
}

/// Fold `gone` into `keep`, then remove it.
fn absorb(w: &mut World, keep: usize, gone: usize) {
    let strength =
        w.walkers[keep].strength.saturating_add(w.walkers[gone].strength).min(MERGE_MAX_STRENGTH);
    let hp = w.walkers[keep].hp.saturating_add(w.walkers[gone].hp).min(MERGE_MAX_HP);
    let carried =
        w.walkers[keep].pop_carried.saturating_add(w.walkers[gone].pop_carried).saturating_add(1);
    w.walkers[keep].strength = strength;
    w.walkers[keep].hp = hp;
    w.walkers[keep].pop_carried = carried;
    w.census.merges = w.census.merges.saturating_add(1);

    // A merge concentrates population; it does not spend it. So the absorbed
    // walker's settlement slot must *not* be released here — `keep` is now
    // carrying it, and will release it when it dies.
    //
    // Detaching `home` before `remove` is what suppresses the credit. Getting
    // this wrong is not subtle in effect but is invisible in a short fixture:
    // `spawn_population` refills any settlement below its tier's population every
    // tick, so a freed slot is refilled next tick, the fresh walker lands on the
    // same cell and merges again. A 20,000-tick match showed 16,928 merges
    // against two surviving walkers before this was fixed.
    w.walkers[gone].home = NO_SETTLEMENT;
    crate::walkers::remove(w, gone);
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
        //
        // The bucket is not rebuilt after `merge`, so a slot here may name a
        // walker that was absorbed this tick. `remove` leaves a defaulted walker
        // with `hp == 0`, so the guards below skip it — the same guards that
        // already skipped walkers killed earlier in this pass. Rebuilding the
        // bucket instead would renumber the segments and cost the §4.7 ordering
        // its by-construction proof for no gain.
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
                //
                // The invincibility predicates are read here too, before either
                // write, for exactly that reason — evaluating one of them after a
                // write would let the pair's outcome depend on which walker the
                // loop reached first.
                let sa = i16::from(w.walkers[a].strength);
                let sb = i16::from(w.walkers[b].strength);
                let a_holy = leader_on_own_magnet(w, &w.walkers[a]);
                let b_holy = leader_on_own_magnet(w, &w.walkers[b]);
                if !a_holy {
                    w.walkers[a].hp -= sb;
                }
                if !b_holy {
                    w.walkers[b].hp -= sa;
                }
                w.census.combat_resolutions = w.census.combat_resolutions.saturating_add(1);
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
        MAT_SOIL, Magnet, MapConfig, N, PLAYERS, SETTLE_ALIVE, Settlement, TERRAIN_PANGAEA,
        TIER_THRESHOLD, WALKER_ALIVE, Walker, idx,
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
            pop_carried: 0,
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
    ///
    /// The two defenders are champions so that TODO-8 merging leaves the scenario
    /// alone. With only two players, any two co-located walkers that are not
    /// enemies are friends, and friends now combine before they fight — a
    /// same-owner pair is no longer a thing that survives to the `fight` pass
    /// unless it is champions, which never merge.
    #[test]
    fn pairs_resolve_in_ascending_id_order() {
        let mut w = arena(2);
        place(&mut w, 0, 0, 4, 20, 20, 5, 5); // dies during the pass
        place(&mut w, 1, 1, 4, 20, 20, 3, 20);
        place(&mut w, 3, 1, 4, 20, 20, 9, 20);
        w.walkers[1].flags |= WALKER_CHAMPION;
        w.walkers[3].flags |= WALKER_CHAMPION;
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
        w.walkers[1].flags |= WALKER_CHAMPION;
        w.walkers[3].flags |= WALKER_CHAMPION;
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

    /// Friendly contact costs nothing. Since TODO-8 it is not a no-op either —
    /// they combine — so the property to hold is that no *damage* was dealt:
    /// strength and hp are conserved across the merge, not reduced by it.
    #[test]
    fn friendly_walkers_never_fight() {
        let mut w = arena(4);
        for slot in [0usize, 2, 4, 6] {
            place(&mut w, slot, 0, 1, 5, 5, 4, 64);
        }
        resolve(&mut w);

        let alive: std::vec::Vec<usize> =
            (0..MAX_WALKERS).filter(|&s| w.walkers[s].alive()).collect();
        assert_eq!(alive, std::vec![0], "four friendly walkers did not combine into the lowest id");
        // 4 x strength 4 and 4 x hp 64, both landing exactly on the cap.
        assert_eq!(w.walkers[0].strength, 16, "strength was not conserved by the merge");
        assert_eq!(w.walkers[0].hp, 256, "hp was not conserved by the merge");
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

    // -----------------------------------------------------------------------
    // TODO-7 — the leader is invincible on its own papal magnet
    // -----------------------------------------------------------------------

    /// Give player `owner` a magnet at the given cell and make `slot` its leader.
    fn crown(w: &mut World, owner: usize, slot: usize, face: usize, x: usize, y: usize) {
        w.magnet[owner] = Magnet {
            face: face as u8,
            x: x as u8,
            y: y as u8,
            active: 1,
            leader: slot as u16,
            _pad: 0,
        };
        w.walkers[slot].flags |= WALKER_LEADER;
    }

    #[test]
    fn leader_on_magnet_takes_no_damage_but_still_deals_it() {
        let mut w = arena(20);
        place(&mut w, 0, 0, 2, 30, 30, 3, 48);
        place(&mut w, 1, 1, 2, 30, 30, 5, 80);
        crown(&mut w, 0, 0, 2, 30, 30);
        resolve(&mut w);

        assert_eq!(w.walkers[0].hp, 48, "the leader on its own magnet took damage");
        assert_eq!(
            w.walkers[1].hp,
            80 - 3,
            "the holy fire did not burn — the leader dealt nothing"
        );
    }

    #[test]
    fn a_leader_off_its_magnet_is_mortal() {
        // Guards against the predicate degenerating into "leaders are
        // invincible", which would make a forward magnet cost-free instead of a
        // decision.
        let mut w = arena(21);
        place(&mut w, 0, 0, 2, 30, 30, 3, 48);
        place(&mut w, 1, 1, 2, 30, 30, 5, 80);
        // Leader of a magnet that sits one cell away.
        crown(&mut w, 0, 0, 2, 31, 30);
        resolve(&mut w);

        assert_eq!(w.walkers[0].hp, 48 - 5, "a leader away from its magnet was invincible anyway");
        assert_eq!(w.walkers[1].hp, 80 - 3);
    }

    #[test]
    fn an_inactive_magnet_grants_no_invincibility() {
        let mut w = arena(22);
        place(&mut w, 0, 0, 2, 30, 30, 3, 48);
        place(&mut w, 1, 1, 2, 30, 30, 5, 80);
        crown(&mut w, 0, 0, 2, 30, 30);
        w.magnet[0].active = 0;
        resolve(&mut w);

        assert_eq!(w.walkers[0].hp, 48 - 5, "an inactive magnet still protected its leader");
    }

    #[test]
    fn a_stale_leader_flag_grants_no_invincibility() {
        // The flag is a cache of `magnet.leader`. A walker that still carries it
        // after the magnet was re-placed (or was given it by anything but
        // `claim_magnet`) is not the leader and burns like anyone else.
        let mut w = arena(29);
        place(&mut w, 0, 0, 2, 30, 30, 3, 48);
        place(&mut w, 1, 1, 2, 30, 30, 5, 80);
        w.magnet[0] = Magnet { face: 2, x: 30, y: 30, active: 1, leader: u16::MAX, _pad: 0 };
        w.walkers[0].flags |= WALKER_LEADER;
        resolve(&mut w);

        assert_eq!(w.walkers[0].hp, 48 - 5, "a stale leader flag protected a walker");
    }

    #[test]
    fn invincibility_does_not_cross_to_the_other_players_magnet() {
        // Standing on the *enemy's* magnet must protect nobody.
        let mut w = arena(23);
        place(&mut w, 0, 0, 2, 30, 30, 3, 48);
        place(&mut w, 1, 1, 2, 30, 30, 5, 80);
        // Player 1's magnet is here; player 0's leader is standing on it.
        w.magnet[1] = Magnet { face: 2, x: 30, y: 30, active: 1, leader: u16::MAX, _pad: 0 };
        w.walkers[0].flags |= WALKER_LEADER;
        resolve(&mut w);

        assert_eq!(w.walkers[0].hp, 48 - 5, "a leader was protected by the enemy's magnet");
    }

    // -----------------------------------------------------------------------
    // TODO-8 — friendly walkers merge on contact
    // -----------------------------------------------------------------------

    #[test]
    fn friendly_walkers_merge_into_the_lowest_id() {
        let mut w = arena(24);
        place(&mut w, 2, 0, 1, 9, 9, 3, 40);
        place(&mut w, 6, 0, 1, 9, 9, 2, 30);
        resolve(&mut w);

        assert!(w.walkers[2].alive(), "the lowest id was not the absorber");
        assert!(!w.walkers[6].alive(), "the higher id was not absorbed");
        assert_eq!(w.walkers[2].strength, 5);
        assert_eq!(w.walkers[2].hp, 70);
    }

    #[test]
    fn a_leader_absorbs_rather_than_being_absorbed() {
        // The rule that keeps `magnet.leader` a valid id: `walkers::remove` drops
        // the magnet for a leader, which is right for a death and wrong for a
        // merge. So the leader must win the absorber role even at the higher id.
        let mut w = arena(25);
        place(&mut w, 2, 0, 1, 9, 9, 3, 40);
        place(&mut w, 6, 0, 1, 9, 9, 2, 30);
        crown(&mut w, 0, 6, 3, 40, 40); // leader is the *higher* id
        resolve(&mut w);

        assert!(w.walkers[6].alive(), "the leader was absorbed by a lower id");
        assert!(!w.walkers[2].alive());
        assert_eq!(w.walkers[6].strength, 5);
        assert_eq!(w.walkers[6].hp, 70);
        assert_eq!(w.magnet[0].leader, 6, "the merge invalidated the magnet's leader id");
        assert_eq!(w.magnet[0].x, 40, "the merge dropped the magnet as if the leader had died");
        assert_eq!(w.magnet[0].y, 40);
    }

    #[test]
    fn a_champion_neither_absorbs_nor_is_absorbed() {
        let mut w = arena(26);
        place(&mut w, 0, 0, 1, 12, 12, 3, 40);
        place(&mut w, 2, 0, 1, 12, 12, 2, 30);
        w.walkers[2].flags |= WALKER_CHAMPION;
        resolve(&mut w);
        assert!(w.walkers[0].alive() && w.walkers[2].alive(), "a champion took part in a merge");
        assert_eq!(w.walkers[0].strength, 3);
        assert_eq!(w.walkers[2].strength, 2);

        // And the other way round: two champions in a cell stay two champions.
        let mut w = arena(26);
        place(&mut w, 0, 0, 1, 12, 12, 3, 40);
        place(&mut w, 2, 0, 1, 12, 12, 2, 30);
        w.walkers[0].flags |= WALKER_CHAMPION;
        w.walkers[2].flags |= WALKER_CHAMPION;
        resolve(&mut w);
        assert!(w.walkers[0].alive() && w.walkers[2].alive());
    }

    #[test]
    fn merging_conserves_population() {
        let mut w = arena(27);
        w.settlements[0] = Settlement {
            progress: TIER_THRESHOLD[2],
            face: 1,
            x: 20,
            y: 20,
            size: 5,
            tier: 2,
            owner: 0,
            pop: 2,
            flags: SETTLE_ALIVE,
        };
        place(&mut w, 0, 0, 1, 20, 20, 2, 32);
        place(&mut w, 2, 0, 1, 20, 20, 2, 32);
        w.walkers[0].home = 0;
        w.walkers[2].home = 0;
        assert_eq!(w.walker_count[0], 2);

        resolve(&mut w);

        assert_eq!(w.walker_count[0], 1, "the merge lost track of the walker count");
        // The slot is *not* released: the absorbed walker's people are still in the
        // field, inside the walker that ate them. Releasing it lets
        // `spawn_population` refill the settlement next tick, the fresh walker lands
        // on this same cell and merges again — a spawn/merge pump that ran at two
        // merges a tick before this was fixed.
        assert_eq!(
            w.settlements[0].pop, 2,
            "the merge released a population slot, which lets the settlement respawn into it"
        );
        assert_eq!(w.walkers[0].pop_carried, 1, "the survivor is not carrying the absorbed slot");

        // And killing the survivor must give back *both*, or a long match strangles
        // its own settlements into never spawning again.
        w.walkers[0].hp = 0;
        resolve(&mut w);
        assert_eq!(w.walker_count[0], 0);
        assert_eq!(
            w.settlements[0].pop, 0,
            "the merged walker's death did not release the population it carried"
        );
    }

    #[test]
    fn a_merge_is_capped_and_never_wraps() {
        let mut w = arena(28);
        // Ten walkers of strength 7 in one cell. Uncapped that is strength 70 and
        // hp 1,120; the cap has to bite on both.
        for k in 0..10usize {
            place(&mut w, k, 0, 5, 40, 40, 7, 112);
        }
        resolve(&mut w);

        // A walker at the cap stops absorbing, so this does *not* collapse to one
        // walker — which is the point. 7 + 7 = 14 is under the cap and merges; the
        // next would exceed it, so each survivor tops out at 16 and the rest stay
        // separate. An army stays an army, and population keeps meaning something.
        let alive: std::vec::Vec<usize> =
            (0..MAX_WALKERS).filter(|&s| w.walkers[s].alive()).collect();
        assert!(
            alive.len() > 1,
            "every walker folded into one — population growth stops mattering at that point"
        );
        for &s in &alive {
            assert!(w.walkers[s].strength <= MERGE_MAX_STRENGTH, "strength passed the cap");
            assert!(w.walkers[s].hp <= MERGE_MAX_HP, "hp passed the cap");
            assert!(w.walkers[s].hp > 0, "a merge zeroed a survivor's hp");
        }
        assert_eq!(w.walker_count[0] as usize, alive.len(), "walker_count drifted from reality");
    }

    /// TODO-8's own stress case. Merging changes walker-count dynamics, so the
    /// §4.7 determinism guarantee has to be re-established for friendly contact
    /// and not inherited from the enemy-contact test.
    #[test]
    fn stress_200_friendly_contacts_is_deterministic() {
        let first = friendly_stress_scenario(0xBEEF);
        for run in 1..100 {
            assert_eq!(
                friendly_stress_scenario(0xBEEF),
                first,
                "merging diverged on run {run} of 100 from the same seed"
            );
        }

        // Prove the harness actually merges rather than matching on a no-op.
        let mut w = arena(0xBEEF);
        place(&mut w, 0, 0, 0, 10, 10, 3, 48);
        place(&mut w, 2, 0, 0, 10, 10, 3, 48);
        let before = w.walker_count[0];
        resolve(&mut w);
        assert_eq!(before, 2);
        assert_eq!(w.walker_count[0], 1, "the friendly stress harness is not actually merging");
    }

    /// 100 cells, four friendly walkers each, spread over all six faces — so the
    /// merge pass has to fold multi-way contacts, not just pairs.
    fn friendly_stress_scenario(seed: u32) -> u64 {
        let mut w = arena(seed);
        let mut placed = 0usize;
        'outer: for face in 0..6usize {
            for k in 0..20usize {
                if placed >= 50 {
                    break 'outer;
                }
                let x = 4 + (k % 5) * 11;
                let y = 4 + (k / 5) * 13;
                for q in 0..4usize {
                    let slot = placed * 4 + q;
                    place(
                        &mut w,
                        slot,
                        (q % 2) as u8,
                        face,
                        x,
                        y,
                        2 + (k % 5) as u8,
                        40 + q as i16,
                    );
                }
                placed += 1;
            }
        }
        assert_eq!(placed, 50, "the friendly stress scenario did not reach 50 cells");

        for _ in 0..60 {
            resolve(&mut w);
        }
        w.state_hash()
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
