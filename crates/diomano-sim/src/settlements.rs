//! Plateau detection, settlement tiers and population. HANDOFF §4.6.
//!
//! **Build sites are contiguous plateaus of exactly equal height.** That single
//! rule is what makes "flatten" a sharp verb with a sharp reward, and it is why
//! wide-versus-tall falls out of the terrain instead of out of a build menu:
//! rolling ground only ever fits huts, so it spreads fast and stays weak; flat
//! ground fits citadels, so it grows slowly and produces strong walkers.

use crate::world::{
    MAT_SWAMP, N, NO_SETTLEMENT, PLAYERS, SETTLE_ALIVE, Settlement, TIER_POP, TIER_SIZE,
    TIER_THRESHOLD, WALKERS_PER_PLAYER, World, idx,
};

/// Build progress per tick for an unmolested settlement.
///
/// `[START]`. At 2/tick a 5x5 reaches house tier in 100 ticks — 3.3 seconds,
/// which is the "within seconds" of the Phase 3 DoD.
pub const BUILD_RATE: i32 = 2;

/// Largest square of exactly equal height whose bottom-right corner is each cell.
///
/// Classic O(1)-per-cell dynamic program. It reads the up-left diagonal, which
/// §3.5 forbids for cellular-automata rules because the diagonal ghost cell at a
/// face corner is ambiguous — so this pass never touches the ghost ring at all
/// and runs strictly inside each face. The cost is that a plateau straddling a
/// face boundary is not detected as one. That is the right trade: the alternative
/// is re-solving cube corners for a convenience.
pub fn detect_plateaus(w: &mut World) {
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                if !buildable(w, c) {
                    w.plateau[c] = 0;
                    continue;
                }
                if x == 0 || y == 0 {
                    w.plateau[c] = 1;
                    continue;
                }
                let left = idx(face, x - 1, y);
                let down = idx(face, x, y - 1);
                let diag = idx(face, x - 1, y - 1);
                let h = w.height[c];
                if w.height[left] == h && w.height[down] == h && w.height[diag] == h {
                    let m = w.plateau[left].min(w.plateau[down]).min(w.plateau[diag]);
                    w.plateau[c] = m.saturating_add(1);
                } else {
                    w.plateau[c] = 1;
                }
            }
        }
    }
}

/// Somewhere a settlement could stand: dry, solid, above the waterline.
#[inline]
#[must_use]
pub fn buildable(w: &World, c: usize) -> bool {
    w.lava[c] == 0
        && w.water[c] == 0
        && w.material[c] != MAT_SWAMP
        && i32::from(w.height[c]) > i32::from(w.sea_level)
}

/// The tier a plateau of `size` can eventually reach.
#[must_use]
pub fn tier_for_size(size: u8) -> u8 {
    let mut best = 0u8;
    for (t, &s) in TIER_SIZE.iter().enumerate() {
        if s != 0 && s <= size {
            best = t as u8;
        }
    }
    best
}

/// The largest settlement footprint that fits in a plateau run of `run` cells.
#[must_use]
pub fn footprint_for_run(run: u8) -> u8 {
    let mut best = 0u8;
    for &s in &TIER_SIZE {
        if s != 0 && s <= run {
            best = s;
        }
    }
    best
}

/// Settlements: build and decay (§4.1 pass 10).
pub fn update(w: &mut World) {
    detect_plateaus(w);
    found_new_settlements(w);
    advance_settlements(w);
    spawn_population(w);
}

/// Look for new build sites.
///
/// Footprints are claimed **largest first**, then in flat-index order within a
/// size. Doing it in one pass instead would let the 3x3 corner of a flattened
/// 5x5 claim the middle of it a few cells before the 5x5 became visible, and a
/// player who flattened more ground would get a smaller settlement for it —
/// which inverts the entire wide-versus-tall axis of §4.2.
fn found_new_settlements(w: &mut World) {
    for &size in &[9u8, 7, 5, 3] {
        found_at_size(w, size);
    }
}

fn found_at_size(w: &mut World, size: u8) {
    let k = size as usize;
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                if w.plateau[c] < size {
                    continue;
                }
                // The plateau's bottom-right corner is (x, y), so the centre sits
                // half a footprint back along both axes.
                let cx = x + 1 - k + k / 2;
                let cy = y + 1 - k + k / 2;
                let centre = idx(face, cx, cy);

                // Only inside somebody's influence. Walkers never leave their own
                // influence without a magnet (§4.5), so a site nobody holds has
                // nobody to build it.
                let infl = i32::from(w.influence[centre]);
                if infl == 0 {
                    continue;
                }
                let owner = u8::from(infl < 0);

                let mut free = true;
                for dy in 0..k {
                    for dx in 0..k {
                        let cell = idx(face, x + 1 - k + dx, y + 1 - k + dy);
                        if w.settle_of[cell] != NO_SETTLEMENT {
                            free = false;
                        }
                    }
                }
                if !free {
                    continue;
                }

                let Some(slot) = free_settlement_slot(w) else { return };
                w.settlements[slot] = Settlement {
                    progress: 0,
                    face: face as u8,
                    x: cx as u8,
                    y: cy as u8,
                    size,
                    tier: 0,
                    owner,
                    pop: 0,
                    flags: SETTLE_ALIVE,
                };
                for dy in 0..k {
                    for dx in 0..k {
                        let cell = idx(face, x + 1 - k + dx, y + 1 - k + dy);
                        w.settle_of[cell] = slot as u16;
                    }
                }
                w.settlement_count = w.settlement_count.saturating_add(1);
            }
        }
    }
}

fn free_settlement_slot(w: &World) -> Option<usize> {
    // Lowest free slot, always. Slot choice feeds the state hash, so it has to
    // be a function of state and nothing else.
    w.settlements.iter().position(|s| !s.alive())
}

fn advance_settlements(w: &mut World) {
    for slot in 0..w.settlements.len() {
        if !w.settlements[slot].alive() {
            continue;
        }
        let s = w.settlements[slot];

        // The ground moved out from under it: a settlement is only ever as good
        // as the plateau it stands on.
        let still_flat = footprint_still_flat(w, &s);
        let cap = tier_for_size(s.size);

        let progress = if still_flat {
            (s.progress + BUILD_RATE).min(TIER_THRESHOLD[cap as usize])
        } else {
            // Not razed, just losing ground: the reaction window of §4.7 applies
            // to terrain damage as much as to enemy walkers.
            s.progress - BUILD_RATE * 2
        };
        w.settlements[slot].progress = progress;

        // Razed only once progress runs out entirely — not merely when it is
        // below hut threshold, which is where every site starts. §4.7's "at hut
        // level the settlement is razed" is about a *falling* settlement; a
        // rising one has to be allowed to pass through the same range.
        if progress < 0 {
            raze(w, slot);
            continue;
        }

        let mut tier = 0u8;
        for (t, &threshold) in TIER_THRESHOLD.iter().enumerate() {
            if t as u8 <= cap && progress >= threshold && t > 0 {
                tier = t as u8;
            }
        }
        w.settlements[slot].tier = tier;
    }
}

fn footprint_still_flat(w: &World, s: &Settlement) -> bool {
    let k = s.size as usize;
    let half = (k / 2) as i32;
    let centre = idx(s.face as usize, s.x as usize, s.y as usize);
    let h = w.height[centre];
    for dy in -half..=half {
        for dx in -half..=half {
            let x = s.x as i32 + dx;
            let y = s.y as i32 + dy;
            if !(0..N as i32).contains(&x) || !(0..N as i32).contains(&y) {
                return false;
            }
            let c = idx(s.face as usize, x as usize, y as usize);
            if w.height[c] != h || !buildable(w, c) {
                return false;
            }
        }
    }
    true
}

/// Remove a settlement and release its footprint.
pub fn raze(w: &mut World, slot: usize) {
    let s = w.settlements[slot];
    if !s.alive() {
        return;
    }
    let k = s.size as usize;
    let half = (k / 2) as i32;
    for dy in -half..=half {
        for dx in -half..=half {
            let x = s.x as i32 + dx;
            let y = s.y as i32 + dy;
            if !(0..N as i32).contains(&x) || !(0..N as i32).contains(&y) {
                continue;
            }
            let c = idx(s.face as usize, x as usize, y as usize);
            if w.settle_of[c] == slot as u16 {
                w.settle_of[c] = NO_SETTLEMENT;
            }
        }
    }
    // Walkers outlive their home; they simply lose it.
    for wk in &mut w.walkers {
        if wk.home == slot as u16 {
            wk.home = NO_SETTLEMENT;
        }
    }
    w.settlements[slot] = Settlement::default();
    w.settlement_count = w.settlement_count.saturating_sub(1);
}

fn spawn_population(w: &mut World) {
    for slot in 0..w.settlements.len() {
        let s = w.settlements[slot];
        if !s.alive() || s.tier == 0 {
            continue;
        }
        let want = TIER_POP[s.tier as usize];
        if s.pop >= want {
            continue;
        }
        let owner = (s.owner as usize) % PLAYERS;
        if w.walker_count[owner] as usize >= WALKERS_PER_PLAYER {
            continue;
        }
        // One walker per settlement per tick keeps spawn order a pure function
        // of slot order and tick count.
        let Some(id) = crate::walkers::spawn(
            w,
            owner,
            s.face as usize,
            s.x as usize,
            s.y as usize,
            crate::world::TIER_STRENGTH[s.tier as usize],
            slot as u16,
        ) else {
            continue;
        };
        let _ = id;
        w.settlements[slot].pop = s.pop.saturating_add(1);
    }
}

/// Bootstrap: one settlement per god, antipodal, so influence is non-zero from
/// tick zero.
///
/// Without this nothing is ever built: founding requires influence and influence
/// is projected from settlements. Populous solved the same circularity by simply
/// placing the first hut.
pub fn seed_starting_positions(w: &mut World) {
    // Faces 4 (+z) and 5 (-z) are opposite, which is as far apart as this
    // topology allows.
    const STARTS: [(usize, usize, usize); PLAYERS] = [(4, N / 2, N / 2), (5, N / 2, N / 2)];
    for (player, &(face, cx, cy)) in STARTS.iter().enumerate() {
        let size = 5usize;
        let half = (size / 2) as i32;
        for dy in -half..=half {
            for dx in -half..=half {
                let c = idx(face, (cx as i32 + dx) as usize, (cy as i32 + dy) as usize);
                w.height[c] = 320;
                w.water[c] = 0;
                w.lava[c] = 0;
                w.material[c] = crate::world::MAT_SOIL;
                w.fertility[c] = w.fertility[c].max(120);
            }
        }
        let slot = player;
        w.settlements[slot] = Settlement {
            progress: TIER_THRESHOLD[2],
            face: face as u8,
            x: cx as u8,
            y: cy as u8,
            size: size as u8,
            tier: 2,
            owner: player as u8,
            pop: 0,
            flags: SETTLE_ALIVE,
        };
        for dy in -half..=half {
            for dx in -half..=half {
                let c = idx(face, (cx as i32 + dx) as usize, (cy as i32 + dy) as usize);
                w.settle_of[c] = slot as u16;
            }
        }
        w.settlement_count = w.settlement_count.saturating_add(1);
    }
    w.ghost_copy_all();
    detect_plateaus(w);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MAT_SOIL, MapConfig, TERRAIN_PANGAEA, TIER_STRENGTH};

    fn plateau_world() -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = 123;
        let mut w = World::boxed();
        w.init(&cfg);
        // Rolling ground everywhere: no accidental plateaus to confuse a test.
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 300 + ((x * 7 + y * 13) % 5) as i16 * 4;
                    w.water[c] = 0;
                    w.lava[c] = 0;
                    w.material[c] = MAT_SOIL;
                    w.settle_of[c] = NO_SETTLEMENT;
                }
            }
        }
        for s in &mut w.settlements {
            *s = Settlement::default();
        }
        w.settlement_count = 0;
        w.walkers.iter_mut().for_each(|k| *k = crate::world::Walker::default());
        w.walker_count = [0; PLAYERS];
        w.ghost_copy_all();
        w
    }

    /// Flatten an area and let go. Nobody is commanded to build; the population
    /// simply reacts to the terrain, which is the whole loop of §4.2.
    fn flatten(w: &mut World, face: usize, cx: usize, cy: usize, k: usize, h: i16) {
        let half = (k / 2) as i32;
        for dy in -half..=half {
            for dx in -half..=half {
                let c = idx(face, (cx as i32 + dx) as usize, (cy as i32 + dy) as usize);
                w.height[c] = h;
                w.water[c] = 0;
            }
        }
        w.ghost_copy_all();
    }

    #[test]
    fn plateau_5x5_produces_house() {
        let mut w = plateau_world();
        // A tier-1 settlement to hold influence over the site, far enough away
        // that it does not claim the plateau itself.
        w.settlements[0] = Settlement {
            progress: TIER_THRESHOLD[3],
            face: 4,
            x: 20,
            y: 32,
            size: 7,
            tier: 3,
            owner: 0,
            pop: 0,
            flags: SETTLE_ALIVE,
        };
        flatten(&mut w, 4, 20, 32, 7, 400);
        for dy in -3i32..=3 {
            for dx in -3i32..=3 {
                let c = idx(4, (20 + dx) as usize, (32 + dy) as usize);
                w.settle_of[c] = 0;
            }
        }
        crate::flowfield::project(&mut w);
        assert!(w.influence[idx(4, 32, 32)] > 0, "test site is not inside player 0's influence");

        flatten(&mut w, 4, 32, 32, 5, 512);

        let mut found = None;
        for t in 0..200u32 {
            w.tick = t;
            update(&mut w);
            if let Some((slot, s)) = w
                .settlements
                .iter()
                .enumerate()
                .find(|(i, s)| *i != 0 && s.alive() && s.face == 4 && s.x == 32 && s.y == 32)
                && s.tier >= 2
            {
                found = Some((slot, *s));
                break;
            }
        }

        let (_, s) = found.expect("flattening a 5x5 did not produce a house within 200 ticks");
        assert_eq!(s.size, 5, "the footprint is not the 5x5 that was flattened");
        assert_eq!(s.tier, 2, "a 5x5 plateau must be a house, not something else");
        assert_eq!(TIER_POP[s.tier as usize], 5);
        assert_eq!(TIER_STRENGTH[s.tier as usize], 2);
    }

    #[test]
    fn a_house_appears_within_a_few_seconds() {
        // The Phase 3 DoD says "within seconds". 30 Hz, so put a number on it.
        assert!(
            TIER_THRESHOLD[2] / BUILD_RATE <= 150,
            "a house takes {} ticks ({} s) to build",
            TIER_THRESHOLD[2] / BUILD_RATE,
            TIER_THRESHOLD[2] / BUILD_RATE / 30
        );
    }

    #[test]
    fn plateau_detection_finds_exactly_the_flattened_square() {
        let mut w = plateau_world();
        flatten(&mut w, 2, 30, 30, 9, 600);
        detect_plateaus(&mut w);
        // Bottom-right corner of the flattened 9x9.
        assert_eq!(w.plateau[idx(2, 34, 34)], 9);
        // One cell further out is not part of it.
        assert!(w.plateau[idx(2, 35, 35)] < 9);
    }

    #[test]
    fn rolling_ground_yields_only_huts_and_flat_ground_yields_citadels() {
        // The central strategic axis of §4.2, asserted as an invariant rather
        // than trusted to emerge.
        let mut w = plateau_world();
        detect_plateaus(&mut w);
        let rolling_best = (0..N)
            .flat_map(|y| (0..N).map(move |x| (x, y)))
            .map(|(x, y)| w.plateau[idx(4, x, y)])
            .max()
            .unwrap();
        assert!(rolling_best < 3, "rolling ground produced a {rolling_best}-cell plateau");

        flatten(&mut w, 4, 32, 32, 9, 512);
        detect_plateaus(&mut w);
        let flat_best = (0..N)
            .flat_map(|y| (0..N).map(move |x| (x, y)))
            .map(|(x, y)| w.plateau[idx(4, x, y)])
            .max()
            .unwrap();
        assert!(flat_best >= 9, "a flattened 9x9 only measured {flat_best}");
    }

    #[test]
    fn water_and_lava_disqualify_a_build_site() {
        let mut w = plateau_world();
        flatten(&mut w, 0, 32, 32, 9, 512);
        w.water[idx(0, 32, 32)] = 4;
        detect_plateaus(&mut w);
        assert!(w.plateau[idx(0, 34, 34)] < 9, "built on a puddle");

        w.water[idx(0, 32, 32)] = 0;
        w.lava[idx(0, 32, 32)] = 4;
        detect_plateaus(&mut w);
        assert!(w.plateau[idx(0, 34, 34)] < 9, "built on lava");
    }

    #[test]
    fn a_settlement_whose_ground_is_broken_loses_progress() {
        let mut w = plateau_world();
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
        flatten(&mut w, 4, 32, 32, 7, 400);
        let before = w.settlements[0].progress;
        // The god digs a hole in someone's fortress.
        w.height[idx(4, 33, 33)] -= 64;
        w.ghost_copy_all();
        update(&mut w);
        assert!(w.settlements[0].progress < before, "broken ground cost nothing");
    }

    #[test]
    fn nothing_is_founded_outside_anyones_influence() {
        let mut w = plateau_world();
        flatten(&mut w, 3, 32, 32, 9, 512);
        for c in 0..w.influence.len() {
            w.influence[c] = 0;
        }
        update(&mut w);
        assert!(
            w.settlements.iter().all(|s| !s.alive()),
            "a settlement appeared on unclaimed ground"
        );
    }

    #[test]
    fn seeded_starts_are_antipodal_and_immediately_hold_influence() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let a = w.settlements[0];
        let b = w.settlements[1];
        assert!(a.alive() && b.alive());
        assert_ne!(a.owner, b.owner);
        assert_eq!(a.face ^ 1, b.face, "starting positions are not on opposite faces");
        assert!(w.influence[idx(a.face as usize, a.x as usize, a.y as usize)] > 0);
        assert!(w.influence[idx(b.face as usize, b.x as usize, b.y as usize)] < 0);
    }

    #[test]
    fn settlements_are_capped_by_the_slot_array_without_panicking() {
        let mut w = plateau_world();
        for s in &mut w.settlements {
            *s = Settlement {
                progress: TIER_THRESHOLD[1],
                face: 0,
                x: 1,
                y: 1,
                size: 3,
                tier: 1,
                owner: 0,
                pop: 99,
                flags: SETTLE_ALIVE,
            };
        }
        flatten(&mut w, 1, 32, 32, 9, 512);
        for c in 0..w.influence.len() {
            w.influence[c] = 40;
        }
        update(&mut w); // must not panic looking for a free slot
    }
}
