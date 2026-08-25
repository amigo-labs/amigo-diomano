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

/// Starting positions, one per god. Faces 4 (+z) and 5 (-z) are opposite,
/// which is as far apart as this topology allows. Public so the CLI and the
/// opponent script read the same cells instead of keeping copies.
pub const STARTS: [(usize, usize, usize); PLAYERS] = [(4, N / 2, N / 2), (5, N / 2, N / 2)];

/// Causeway crest band: every dry carved cell lands in
/// `[CAUSEWAY_CREST_MIN - 2, CAUSEWAY_CREST_MAX]` = `[34, 45]`.
///
/// Three constraints pin the band, the same three that used to pin the single
/// height. Above the calm sea, so the road is normally open. The band floor
/// (34, crest minimum minus the widest lateral falloff) stays above
/// `powers::FLOOD_CAP` (two terraces = 32), so no amount of flooding closes
/// the road *permanently* — traced: with the road below the cap, two flood
/// casts amputated the game's one artery and every walker on both sides
/// parked at home for the rest of the match. And the band ceiling (45) stays
/// below every wave peak (the first is 48), so each tide impact still floods
/// the road and each recovery hands it back — the contest is temporary by
/// design, §5.5. Inside those walls the crest wanders, because a ridge at one
/// exact height for half the planet's circumference reads as a wall, not as
/// geography.
pub const CAUSEWAY_CREST_MIN: i16 = 36;
pub const CAUSEWAY_CREST_MAX: i16 = 45;

/// The band's midpoint — what the docs and the flood arithmetic reference.
pub const CAUSEWAY_HEIGHT: i16 = 2 * crate::world::TERRACE + crate::world::TERRACE / 2;

/// Salt for the causeway's deterministic jitter. The heights may use the world
/// seed (each map gets its own ridge); only the *path* must stay a pure
/// function of the walk index, and it does — see `corridor_cell`.
const CAUSEWAY_SALT: u32 = 0xCA05_E3A7;

/// Salt for the spawn shelf's fringe noise. Separate from `CAUSEWAY_SALT` so
/// that a spawn's outline and the road's crest cannot rhyme.
const SPAWN_FRINGE_SALT: u32 = 0x5EDE_57A1;

/// Submarine apron targets by ring beyond the dry band: a stepped ramp, all
/// below the calm sea (0), so the flanks read as a ridge rising out of the
/// sea floor instead of a sheer wall — and never as new passable land.
const CAUSEWAY_APRON: [i16; 3] = [-8, -64, -160];

/// Minimum height of the 5x5 spawn plateau — the documented 320 of §5.4. On
/// terrain that stands taller than this near a spawn, the platform rises with
/// it: see `spawn_platform_height`.
pub const SPAWN_PLATFORM_MIN_HEIGHT: i16 = 320;

/// The whole pedestal argument collapses if a repose retune drops below the
/// terrace step, so pin it at compile time.
const _: () = assert!(crate::world::TERRACE as i32 <= crate::materials::REPOSE_ASH);

/// Where the flat rock shelf begins, as a Chebyshev ring. The 5x5 platform
/// occupies r <= 2 and this is the first ring outside it.
///
/// Still Chebyshev, and deliberately: the platform is a *square* because
/// `detect_plateaus` measures square plateaus, and the ring that protects it has
/// to have the same shape or it would eat a corner of the thing it protects.
/// Everything outside this is round — see [`carve_spawn_pedestal`].
pub const SPAWN_SHELF_INNER: i32 = 3;

/// Outer radius of the shelf, x16, before the fringe is added.
///
/// This replaced a Chebyshev `r <= 5`, i.e. a square, which is most of why a
/// spawn read as a building rather than as a hill. 5.2 cells (83/16) is the
/// smallest radius that still contains the whole `SPAWN_SHELF_INNER` ring
/// (its corner sits at sqrt(18) = 4.25), so the protective ring cannot be
/// clipped by rounding the shelf off.
///
/// It also has to leave `found_at_size(3)` a flat 3x3 somewhere on the shelf,
/// because that is what stops one earthquake on the platform from being an
/// instant sudden-death loss — the seed settlement must not be the player's only
/// influence source. Along an axis the shelf spans dx = 3..=5 at |dy| <= 1, all
/// of it inside 5.2, so the 3x3 at (4, 0) is there by construction and
/// `the_spawn_shelf_founds_satellites` keeps checking that it is.
const SPAWN_SHELF_RADIUS_16: i32 = 83;

/// How far the shelf's outer edge may wander outward, x16. Outward only: the
/// fringe may add ground, never take it, so every guarantee above survives any
/// seed.
const SPAWN_FRINGE_16: i32 = 22;

/// Outer radius of the submarine apron, x16 — where the seamount meets the
/// ocean floor and stops being forced at all.
///
/// 11 cells, so the loop's reach is 12: exactly [`SPAWN_SURVEY_RADIUS`], which is
/// the radius `spawn_platform_height` already assumes stays inside a face. Wider
/// than the old three rings on purpose — the flank then drops about 33 units per
/// cell instead of 56 and 96, and a slope that shallow reads as a seamount rather
/// than as the top of a wall.
const SPAWN_APRON_RADIUS_16: i32 = 176;

/// How far around a spawn the local relief is surveyed before the platform
/// height is chosen. Granular material only ever moves downhill, so a pile
/// can never climb above its own source; a platform whose shelf clears every
/// cell this survey sees cannot be buried by anything the survey saw.
const SPAWN_SURVEY_RADIUS: i32 = 12;

/// The apron's height at the shelf edge and at its outer radius. Everything
/// between is interpolated, so the flank is a slope rather than three terraces.
///
/// Both below the calm sea (0) by construction, which is the load-bearing part:
/// the apron is geography the walkers cannot use, and an apron cell that dried
/// out would be a free bridge off the spawn.
const SPAWN_APRON_TOP: i32 = -8;
const SPAWN_APRON_TOE: i32 = -200;

/// The height this spawn's 5x5 platform is forced to: at least the documented
/// 320, and always two terraces above the tallest natural cell the survey
/// sees. The old fixed 320 dug the platform into a *pit* wherever the
/// generator raised real mountains around a spawn (pangaea, some volcano
/// seeds) — and the first tick of physics slid sand from above onto the
/// plateau, broke its flatness, and razed the seed settlement inside two
/// seconds. Two terraces, not one: the shelf sits one terrace below the
/// platform and must itself clear the surveyed relief.
fn spawn_platform_height(w: &World, face: usize, cx: i32, cy: i32) -> i16 {
    let t = i32::from(crate::world::TERRACE);
    let mut max_h = i32::from(SPAWN_PLATFORM_MIN_HEIGHT) - 2 * t;
    for dy in -SPAWN_SURVEY_RADIUS..=SPAWN_SURVEY_RADIUS {
        for dx in -SPAWN_SURVEY_RADIUS..=SPAWN_SURVEY_RADIUS {
            let c = idx(face, (cx + dx) as usize, (cy + dy) as usize);
            max_h = max_h.max(i32::from(w.height[c]));
        }
    }
    // Round up to a terrace, then clear it by two.
    let aligned = max_h.div_euclid(t) * t + if max_h.rem_euclid(t) == 0 { 0 } else { t };
    (aligned + 2 * t).min(i32::from(crate::world::HEIGHT_MAX)) as i16
}

/// Shape the ground around one spawn platform: a flat rock shelf one terrace
/// down, then a submarine flank that slopes away to the sea floor.
///
/// The shelf step is load-bearing twice over. The platform-to-shelf drop is
/// `TERRACE`, which sits *at* the ash angle of repose and *below* the sand
/// one — so even if every platform cell turns to quake-ash or rot-sand, the
/// material rests on the shelf instead of avalanching 600+ units into the
/// ocean the archipelago generator puts around the spawns. And the shelf
/// itself is rock: it never becomes ash (earthquake converts soil only),
/// never rots, never slides. Raise-only below the shelf height, like
/// `carve_cell` — it never digs.
///
/// # It used to be square, and that was the first thing anyone saw
///
/// The shelf was a Chebyshev ring (`r <= 5`) and the apron three more of them,
/// so a spawn was a perfect square mesa inside a perfect square rock band
/// inside three perfect square terraces — the most conspicuous piece of grid on
/// the planet, and by some distance the most artificial thing in frame.
///
/// It is now round, with two changes that make it read as a hill:
///
/// - The outer edge is a **euclidean radius plus a coherent fringe**. The fringe
///   is one octave of the terrain generator's own value noise sampled at the 3D
///   cube point (`world::noise_at`, lattice spacing two cells), not a per-cell
///   hash — a per-cell hash gives a speckled edge of orphaned cells, whereas a
///   noise lattice gives an outline that wanders. It is applied **outward only**,
///   so the shelf can gain ground and never lose it, and every guarantee that
///   depends on the shelf's width holds for any seed rather than for the seeds
///   that were tried.
/// - The apron is a **slope**, not three terraces: its target height is
///   interpolated from `SPAWN_APRON_TOP` at the shelf edge to `SPAWN_APRON_TOE`
///   at the outer radius. Same argument as `CAUSEWAY_APRON` — the pedestal must
///   rise out of the sea floor rather than stand on a sheer wall — but three
///   steps of 56 and 96 units were doing the opposite of that in the shallows,
///   where they are exactly the terraces the eye reads as construction.
///
/// The interpolation is in radius, not in squared radius, hence the `isqrt`: a
/// ramp linear in `d2` falls slowly at the top and steeply at the toe, which is
/// an upside-down seamount.
fn carve_spawn_pedestal(w: &mut World, face: usize, cx: i32, cy: i32, platform: i16) {
    let shelf = platform - crate::world::TERRACE;
    let reach = SPAWN_APRON_RADIUS_16 / 16 + 1;
    for dy in -reach..=reach {
        for dx in -reach..=reach {
            // The inner ring keeps the platform's shape: `detect_plateaus`
            // measures square plateaus, so the ring that guards the 5x5 must be
            // square too or it would clip a corner of what it is guarding.
            if dx.abs().max(dy.abs()) < SPAWN_SHELF_INNER {
                continue;
            }
            let (x, y) = (cx + dx, cy + dy);
            // Radius x16, so the fringe and the ramp both have sub-cell
            // resolution without a single float.
            let r16 = ((dx * dx + dy * dy) * 256).isqrt();
            // Outward only. `noise_at` returns 0..=65535.
            let (px, py, pz) = crate::world::cube_point(face, x, y);
            let fringe = crate::world::noise_at(px, py, pz, 8, w.cfg.seed ^ SPAWN_FRINGE_SALT)
                * SPAWN_FRINGE_16
                / 65535;
            let shelf_edge = SPAWN_SHELF_RADIUS_16 + fringe;
            if r16 <= shelf_edge {
                let c = idx(face, x as usize, y as usize);
                if w.height[c] < shelf {
                    w.height[c] = shelf;
                    w.material[c] = crate::world::MAT_ROCK;
                    w.sediment[c] = 0;
                    w.vegetation[c] = 0;
                    w.fertility[c] = 0;
                    w.water[c] = 0;
                    w.lava[c] = 0;
                }
            } else if r16 <= SPAWN_APRON_RADIUS_16 {
                // Height is a function of radius alone — of the *unjittered*
                // radius, not of this cell's own shelf edge. Measuring the ramp
                // from `shelf_edge` seemed the natural thing and was wrong twice:
                // the fringe varies per cell, so adjacent flank cells sat at
                // different points on the ramp and the slope came out lumpy by up
                // to 50 units a cell, worse than the three terraces it replaced.
                //
                // Anchored here the flank is a clean 33 units per cell for every
                // seed, and the fringe does only the job it is for: deciding where
                // the shelf stops and the flank starts, which is the outline you
                // can actually see from above.
                const SPAN: i32 = SPAWN_APRON_RADIUS_16 - SPAWN_SHELF_RADIUS_16;
                let t = r16 - SPAWN_SHELF_RADIUS_16;
                let h = SPAWN_APRON_TOP + (SPAWN_APRON_TOE - SPAWN_APRON_TOP) * t / SPAN;
                raise_seabed(w, face, x, y, h as i16);
            }
        }
    }
}

/// Great-circle steps from one spawn to its antipode: half of the 4N loop.
pub const CORRIDOR_STEPS: usize = 2 * N;

/// Visit every spine cell of the contact corridor in walk order: a great
/// circle from `STARTS[0]` heading north for `CORRIDOR_STEPS` cells, then an
/// L-join to `STARTS[1]`, so the endpoint is exact whatever the seam flips
/// did to the walk. Pure in its path — it reads no world state — which is what
/// lets `corridor_cell` replay it for scripts. The visitor also receives the
/// walk's current heading (in the local face frame), which is what lets the
/// carver step sideways through seams; path-only callers ignore it.
fn walk_corridor(mut visit: impl FnMut(usize, i32, i32, usize)) {
    let (start_face, sx, sy) = STARTS[0];
    let (target_face, tx, ty) = STARTS[1];
    let (mut face, mut x, mut y) = (start_face, sx as i32, sy as i32);
    let mut dir = crate::seams::DIR_N;
    visit(face, x, y, dir);
    for _ in 0..CORRIDOR_STEPS {
        let (nf, nx, ny, nd) = crate::seams::step(face, x, y, dir);
        face = nf;
        x = nx;
        y = ny;
        dir = nd;
        visit(face, x, y, dir);
    }
    if face != target_face {
        // Unreachable on the shipped STARTS: the walk is the great circle
        // through both spawns. Kept as a guard rather than a panic so a future
        // STARTS change degrades to "no L-join" instead of a crash.
        return;
    }
    let (tx, ty) = (tx as i32, ty as i32);
    while x != tx {
        let d = if tx > x { crate::seams::DIR_E } else { crate::seams::DIR_W };
        x += (tx - x).signum();
        visit(face, x, y, d);
    }
    while y != ty {
        let d = if ty > y { crate::seams::DIR_N } else { crate::seams::DIR_S };
        y += (ty - y).signum();
        visit(face, x, y, d);
    }
}

/// The corridor's spine cell at walk index `i`, clamped to the far end. A pure
/// function of `i`, so a recorded script can name causeway waypoints without
/// the log ever depending on world state.
#[must_use]
pub fn corridor_cell(i: usize) -> (u8, u8, u8) {
    let mut k = 0usize;
    let mut out = (STARTS[0].0 as u8, STARTS[0].1 as u8, STARTS[0].2 as u8);
    walk_corridor(|face, x, y, _| {
        if k <= i {
            out = (face as u8, x as u8, y as u8);
        }
        k += 1;
    });
    out
}

/// Raise one corridor cell to at least `h` and make it dry, bare rock.
///
/// Existing land above `h` — including the spawn plateaus at 320 — keeps its
/// height: the corridor only ever adds passage, it never digs. Its *material*
/// becomes rock regardless, because the road runs through whatever the
/// generator put there, and a natural sand bank on the spine is a time bomb:
/// traced on the widened terrain, one such bank eroded below the sea inside
/// two tide cycles and cut the game's one artery. `MAT_ROCK` is deliberate
/// twice over. Physically: rock is the one material that neither erodes
/// (§4.4 — "the absence is the rule") nor obeys the angle of repose, and a
/// sand ridge 400+ units above the sea floor sheds `(diff - 24) / 4` per tick
/// per neighbour — a sand causeway dissolves within the first few hundred
/// ticks, measured. Strategically: rock is habitable, so the road is not just
/// passage but contestable, *scoring* ground — holding the causeway pays,
/// which is exactly the fight §5.5 wants the geography to cause.
fn carve_cell(w: &mut World, face: usize, x: i32, y: i32, h: i16) {
    let c = idx(face, x as usize, y as usize);
    if w.height[c] < h {
        w.height[c] = h;
        w.material[c] = crate::world::MAT_ROCK;
        w.sediment[c] = 0;
        w.vegetation[c] = 0;
        w.fertility[c] = 0;
    } else if w.material[c] == crate::world::MAT_SAND || w.material[c] == crate::world::MAT_ASH {
        // Natural land already above the band keeps its height, but granular
        // ground on the road is pinned to rock: it obeys the angle of repose,
        // and it erodes out from under the road otherwise. Soil stays soil —
        // it does not move, and the spawn plateaus are deliberately soil.
        w.material[c] = crate::world::MAT_ROCK;
        w.sediment[c] = 0;
    }
    // Carved cells all sit above the calm sea; whatever the terrain fill put
    // here is gone. The tide will flood the road again — that is the game.
    w.water[c] = 0;
    w.lava[c] = 0;
}

/// Raise the sea floor beside the road to `h` (below the calm sea) and pin it
/// as rock. Unlike `carve_cell` this never dries anything: the cell stays
/// ocean, refilled to sea level, so the apron is a submarine ridge the walkers
/// cannot use — pure geography, there so the road climbs out of the deep in
/// steps instead of standing on a sheer half-kilometre wall.
fn raise_seabed(w: &mut World, face: usize, x: i32, y: i32, h: i16) {
    let c = idx(face, x as usize, y as usize);
    if w.height[c] < h {
        w.height[c] = h;
        w.material[c] = crate::world::MAT_ROCK;
        w.sediment[c] = 0;
        let depth = i32::from(w.sea_level) - i32::from(h);
        w.water[c] = depth.max(0).min(i32::from(i16::MAX)) as i16;
    }
}

/// The contested causeway between the two spawns (HANDOFF §1 pillar 5).
///
/// Without a land connection the two peoples never meet on an archipelago:
/// walkers cannot swim, the tide returns to baseline every wave, and the §6.3
/// corpus recorded exactly zero combat resolutions because of it. A low,
/// narrow road that every wave floods and every recovery returns makes
/// contact inevitable but permanently contested — either god can cut it,
/// fortify it, or fight over it, and "every causeway you build also serves
/// your opponent" (§5.5) becomes literal geography.
///
/// The *shape* is deliberately not a wall. The spine path is fixed (see
/// `corridor_cell`), but on it a crest wanders laterally by one cell, its
/// height random-walks inside the `[CAUSEWAY_CREST_MIN, CAUSEWAY_CREST_MAX]`
/// band, occasional stretches widen into islets, and beyond the dry band a
/// stepped rock apron rises from the sea floor. All jitter derives from
/// `hash3` of the walk index and the world seed — deterministic, and pure of
/// world state, so the walk order alone fixes every cell.
///
/// Two properties hold by construction, for any seed. Passability: the spine
/// cell (`k = 0`) is at lateral distance `|m| <= 1` from the crest, so it is
/// carved to at least `base - 1 >= CAUSEWAY_CREST_MIN - 1 > FLOOD_CAP`, and
/// the spine is 4-connected — `spawns_are_connected_at_tick_zero` stays a
/// consequence, not a hope. No build site: lateral heights fall off strictly
/// unimodally from the crest (`base, base-1, base-2`), so no three
/// equal-height cells ever sit in a row across the band, and no 3x3
/// equal-height plateau forms on the road for anyone to found on.
fn carve_contact_corridor(w: &mut World) {
    let seed = w.cfg.seed ^ CAUSEWAY_SALT;
    let mut k: i32 = 0;
    // Lazy random walks: the crest offset moves at most one cell every four
    // steps, the base height one unit every other step — arcs, not noise.
    let mut crest: i32 = 0;
    let mut base: i32 = i32::from(CAUSEWAY_HEIGHT);
    walk_corridor(|face, x, y, dir| {
        if k % 4 == 0 {
            let r = (crate::hash::hash3(k, 1, 0, seed) % 3) as i32;
            crest = (crest + r - 1).clamp(-1, 1);
        }
        if k % 2 == 0 {
            let r = (crate::hash::hash3(k, 2, 0, seed) % 3) as i32;
            base =
                (base + r - 1).clamp(i32::from(CAUSEWAY_CREST_MIN), i32::from(CAUSEWAY_CREST_MAX));
        }
        // Occasional islets: stretches of 6 spine cells gain an extra ring.
        let extra = i32::from(crate::hash::hash3(k / 6, 3, 0, seed) & 3 == 0);
        let width = 1 + extra;

        let carve = |w: &mut World, f: usize, cx: i32, cy: i32, lat: i32| {
            let bd = (lat - crest).abs();
            if bd <= width {
                carve_cell(w, f, cx, cy, (base - bd) as i16);
            } else if bd <= width + 3 {
                raise_seabed(w, f, cx, cy, CAUSEWAY_APRON[(bd - width - 1) as usize]);
            }
        };
        carve(w, face, x, y, 0);
        // Step sideways from the spine, seam-aware, far enough to cover the
        // widest dry band plus the three apron rings on each side.
        for side in [1usize, 3] {
            let (mut f, mut cx, mut cy) = (face, x, y);
            let mut d = (dir + side) % 4;
            for n in 1..=(width + 4) {
                let (nf, nx, ny, nd) = crate::seams::step(f, cx, cy, d);
                f = nf;
                cx = nx;
                cy = ny;
                d = nd;
                let lat = if side == 1 { n } else { -n };
                carve(w, f, cx, cy, lat);
            }
        }
        k += 1;
    });
}

/// Bootstrap: one settlement per god, antipodal, so influence is non-zero from
/// tick zero.
///
/// Without this nothing is ever built: founding requires influence and influence
/// is projected from settlements. Populous solved the same circularity by simply
/// placing the first hut.
pub fn seed_starting_positions(w: &mut World) {
    for (player, &(face, cx, cy)) in STARTS.iter().enumerate() {
        // Surveyed before anything is forced, so the natural relief under the
        // platform itself still counts.
        let platform = spawn_platform_height(w, face, cx as i32, cy as i32);
        let size = 5usize;
        let half = (size / 2) as i32;
        for dy in -half..=half {
            for dx in -half..=half {
                let c = idx(face, (cx as i32 + dx) as usize, (cy as i32 + dy) as usize);
                w.height[c] = platform;
                w.water[c] = 0;
                w.lava[c] = 0;
                w.material[c] = crate::world::MAT_SOIL;
                // A fixed value, not `max(120)`: the generator's fertility is
                // asymmetric between the two spawns, and whichever god drew
                // less watched their only soil rot to sand — and slide — first
                // in an idle match. 200 also pushes the first possible rot
                // past any decided match (600 + 200*60 ticks > 7 waves).
                w.fertility[c] = 200;
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
        carve_spawn_pedestal(w, face, cx as i32, cy as i32, platform);
    }
    carve_contact_corridor(w);
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

    /// The load-bearing playability assertion: whatever the terrain noise
    /// does, a land path between the two spawns exists from tick zero. If this
    /// fails, the two peoples cannot meet and the game has no war in it.
    #[test]
    fn spawns_are_connected_at_tick_zero() {
        for terrain in [
            crate::world::TERRAIN_ARCHIPELAGO,
            crate::world::TERRAIN_PANGAEA,
            crate::world::TERRAIN_VOLCANO,
        ] {
            for seed in [0x5EEDu32, 1, 7, 99] {
                let mut cfg = MapConfig::DEFAULT;
                cfg.terrain = terrain;
                cfg.seed = seed;
                let mut w = World::boxed();
                w.init(&cfg);

                let start = idx(STARTS[0].0, STARTS[0].1, STARTS[0].2);
                let goal = idx(STARTS[1].0, STARTS[1].1, STARTS[1].2);
                let mut seen = alloc::vec![false; crate::world::CELLS];
                let mut queue = alloc::vec![start];
                seen[start] = true;
                let mut reached = false;
                while let Some(c) = queue.pop() {
                    if c == goal {
                        reached = true;
                        break;
                    }
                    for dir in 0..4usize {
                        let n = crate::world::live_neighbour(c, dir);
                        if !seen[n] && w.passable(n) {
                            seen[n] = true;
                            queue.push(n);
                        }
                    }
                }
                assert!(reached, "spawns disconnected on terrain {terrain} seed {seed:#x}");
            }
        }
    }

    #[test]
    fn the_causeway_floods_at_wave_peak_and_reopens() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);

        let peak = crate::tide::wave_strength(&w, 0);
        // The whole crest band sits under every wave peak and its lowest dry
        // cell stays above the flood cap — the two walls of the design.
        assert!(
            i32::from(CAUSEWAY_CREST_MAX) < i32::from(w.sea_base) + i32::from(peak),
            "the first wave peak does not clear the causeway band"
        );
        assert!(
            i32::from(CAUSEWAY_CREST_MIN) - 2 > i32::from(crate::powers::FLOOD_CAP),
            "the causeway band floor is floodable shut"
        );

        // Probe a carved-ocean spine cell (band height, not natural land): a
        // quarter of the way along, scanning forward past any natural ridge.
        let c = (N..CORRIDOR_STEPS)
            .map(|i| {
                let (face, x, y) = corridor_cell(i);
                idx(face as usize, x as usize, y as usize)
            })
            .find(|&c| w.height[c] <= CAUSEWAY_CREST_MAX)
            .expect("no carved-ocean cell in the corridor's back half");
        assert!(w.passable(c), "the causeway is not passable at calm sea");
        w.sea_level = w.sea_base + peak;
        assert!(!w.passable(c), "the causeway survives a wave peak");
        w.sea_level = w.sea_base;
        assert!(w.passable(c), "the causeway does not reopen after the wave");
    }

    #[test]
    fn the_causeway_is_passable_and_unsettleable() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let mut carved_ocean = 0usize;
        for i in 0..CORRIDOR_STEPS {
            let (face, x, y) = corridor_cell(i);
            let c = idx(face as usize, x as usize, y as usize);
            assert!(w.passable(c), "corridor cell {i} is not passable");
            if (CAUSEWAY_CREST_MIN - 2..=CAUSEWAY_CREST_MAX).contains(&w.height[c]) {
                carved_ocean += 1;
                // The unimodal lateral falloff exists so no 3x3 equal-height
                // plateau ever forms on the road: contestable ground, never a
                // build site.
                assert!(w.plateau[c] < 3, "corridor cell {i} is a build site");
            }
        }
        // On the archipelago most of the road really is reclaimed ocean; if
        // nothing was carved the corridor did not do its job.
        assert!(carved_ocean > CORRIDOR_STEPS / 2, "the causeway carved almost nothing");
    }

    #[test]
    fn the_causeway_band_never_founds_a_settlement() {
        // The passable/unsettleable test walks the spine; this one covers the
        // whole carved band, on several seeds, since the crest jitter is
        // seed-dependent. Any dry band cell that detects as a 3x3 plateau
        // would hand a player a build site in the middle of the one road.
        for seed in [0x5EEDu32, 1, 7, 99] {
            let mut w = World::boxed();
            w.init(&MapConfig { seed, ..MapConfig::DEFAULT });
            for face in 0..6usize {
                for y in 0..N {
                    for x in 0..N {
                        let c = idx(face, x, y);
                        if (CAUSEWAY_CREST_MIN - 2..=CAUSEWAY_CREST_MAX).contains(&w.height[c])
                            && w.material[c] == crate::world::MAT_ROCK
                            && w.water[c] == 0
                        {
                            assert!(
                                w.plateau[c] < 3,
                                "seed {seed:#x}: band cell f{face} ({x},{y}) is a build site"
                            );
                        }
                    }
                }
            }
        }
    }

    /// The road has to survive the physics it is parked in: granular movement
    /// would dissolve a sand ridge in minutes (measured — that is why it is
    /// rock), and the first tide waves must close it only *temporarily*. Two
    /// full tide cycles of empty ticks, then the spawns must still connect.
    #[test]
    fn the_causeway_survives_the_early_game() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for _ in 0..3_600 {
            w.tick(&[]);
        }
        // Sea back at base between waves; the road must be open again.
        assert_eq!(w.sea_level, w.sea_base, "not sampled between waves — adjust the tick count");
        let start = idx(STARTS[0].0, STARTS[0].1, STARTS[0].2);
        let goal = idx(STARTS[1].0, STARTS[1].1, STARTS[1].2);
        let mut seen = alloc::vec![false; crate::world::CELLS];
        let mut queue = alloc::vec![start];
        seen[start] = true;
        let mut reached = false;
        while let Some(c) = queue.pop() {
            if c == goal {
                reached = true;
                break;
            }
            for dir in 0..4usize {
                let n = crate::world::live_neighbour(c, dir);
                if !seen[n] && w.passable(n) {
                    seen[n] = true;
                    queue.push(n);
                }
            }
        }
        assert!(reached, "the causeway did not survive 3,600 ticks of physics and tide");
    }

    /// Cells each player influences right now — the quantity sudden death
    /// watches (tide.rs::check_sudden_death).
    fn influence_held(w: &World) -> [u32; PLAYERS] {
        let mut held = [0u32; PLAYERS];
        for &i in &w.influence {
            if i32::from(i) > 0 {
                held[0] += 1;
            } else if i32::from(i) < 0 {
                held[1] += 1;
            }
        }
        held
    }

    /// The regression this whole pedestal exists for: with the shipped map and
    /// the scripted opponent, the match must survive the opening war. Before
    /// the pedestal, the AI's *first earthquake* turned the player's 5x5
    /// spawn — their entire territory on the deep-ocean archipelago — into
    /// ash that avalanched into the sea, and sudden death ended the match in
    /// under 80 seconds with no player mistake anywhere. Now the ash rests on
    /// the shelf and the shelf satellites keep influence alive, so 3,000
    /// ticks covers several strikes and the army's arrival. (A player who
    /// *never* acts still loses to the marching army around tick ~4,200 —
    /// that is the opponent legitimately winning a war nobody contested,
    /// §5.5, not this bug.)
    #[test]
    fn the_default_match_survives_the_opening_war() {
        let mut w = World::boxed();
        w.init(&MapConfig { ai_enabled: 1, ..MapConfig::DEFAULT });
        for _ in 0..3_000 {
            w.tick(&[]);
        }
        assert_eq!(w.outcome, 0, "the default match decided itself during the opening war");
        let held = influence_held(&w);
        assert!(held[0] > 0, "player 0 lost all influence by tick 3,000");
        assert!(held[1] > 0, "player 1 lost all influence by tick 3,000");
    }

    /// With no opponent and no input at all, the world alone must not dissolve
    /// a spawn: before the fixed seed fertility, dry-rot turned the player's
    /// soil to sand around tick 8,300 and the sand slid off the mesa — an idle
    /// match was a guaranteed sudden-death loss for player 0 specifically,
    /// because the generator dealt them less fertility than the opponent.
    #[test]
    fn an_idle_default_match_is_not_dissolved_by_rot() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for _ in 0..9_000 {
            w.tick(&[]);
        }
        assert_eq!(w.outcome, 0, "an idle match decided itself");
        let held = influence_held(&w);
        assert!(held[0] > 0, "player 0's spawn dissolved with nobody touching it");
        assert!(held[1] > 0, "player 1's spawn dissolved with nobody touching it");
    }

    /// One enemy earthquake on the spawn plateau — the scripted opponent's
    /// actual opening strike, same target offset — must wound, not end. The
    /// dents raze the seed settlement, but the ash has to rest on the shelf
    /// (TERRACE <= REPOSE_ASH) instead of avalanching, and the shelf
    /// satellites have to keep the player's influence alive.
    #[test]
    fn the_spawn_pedestal_survives_an_earthquake() {
        let mut cfg = MapConfig::DEFAULT;
        cfg.power_cost = [0; crate::world::POWER_COUNT];
        let mut w = World::boxed();
        w.init(&cfg);
        // Let the shelf satellites found and project first, as they have in
        // any real match by the time the AI can afford the strike.
        for _ in 0..300 {
            w.tick(&[]);
        }
        let quake = crate::world::Command {
            tick: w.tick,
            x: (STARTS[0].1 as i32 + 1) as u16,
            y: (STARTS[0].2 as i32 - 1) as u16,
            player: 1,
            verb: crate::world::VERB_EARTHQUAKE,
            face: STARTS[0].0 as u8,
            modifier: 0,
        };
        w.tick(&[quake]);
        for _ in 0..900 {
            w.tick(&[]);
        }
        assert_eq!(w.outcome, 0, "one earthquake on the spawn ended the match");
        assert!(influence_held(&w)[0] > 0, "one earthquake erased player 0's influence");
        // The land itself must still be there: nothing near the spawn may have
        // slid into the abyss below the causeway band.
        let (face, cx, cy) = STARTS[0];
        let mut dry_land = 0usize;
        for dy in -7i32..=7 {
            for dx in -7i32..=7 {
                let c = idx(face, (cx as i32 + dx) as usize, (cy as i32 + dy) as usize);
                if w.height[c] > CAUSEWAY_CREST_MAX {
                    dry_land += 1;
                }
            }
        }
        assert!(dry_land >= 60, "the spawn pedestal avalanched: {dry_land} tall cells left");
    }

    /// The shelf is not scenery: the game's own founding loop must raise
    /// satellites on it within seconds, because those satellites are what
    /// makes sudden death mean "lost all ground" instead of "lost one cast".
    #[test]
    fn the_spawn_pedestal_is_round_and_its_flank_is_a_slope() {
        // The pedestal used to be a Chebyshev square inside a Chebyshev square
        // ring inside three more of them, and it was the most conspicuous piece
        // of grid on the planet. Both halves of the fix are pinned here, because
        // both are invisible to every other test: they all ask whether the shelf
        // *works*, and a square one works fine.
        //
        // Carved onto a deep, uniform sea floor rather than onto generated
        // terrain, and `carve_spawn_pedestal` is called directly. Both matter:
        // the carve is raise-only, so on real terrain every cell that was
        // already higher keeps its own height and the test would end up
        // measuring the generator instead of the shape.
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = -600;
                    w.water[c] = 600;
                    w.lava[c] = 0;
                }
            }
        }
        let platform: i16 = 320;
        let shelf = platform - crate::world::TERRACE;
        let (face, cx, cy) = STARTS[0];
        let (cx, cy) = (cx as i32, cy as i32);
        carve_spawn_pedestal(&mut w, face, cx, cy, platform);
        let at = |dx: i32, dy: i32| w.height[idx(face, (cx + dx) as usize, (cy + dy) as usize)];

        // Round. The corner of the old Chebyshev-5 shelf sits at radius
        // sqrt(50) = 7.07, and the shelf edge cannot reach past
        // (83 + 22) / 16 = 6.56 for any seed, so a square corner is never
        // forced — while the axis at the same Chebyshev distance still is.
        // That pair is a statement about shape rather than about size.
        assert!(
            at(5, 5) < shelf,
            "the shelf still reaches its Chebyshev corner (5,5) at {}, so it is still a square",
            at(5, 5)
        );
        assert_eq!(at(5, 0), shelf, "the shelf does not reach (5,0) on the axis");
        assert_eq!(at(0, -5), shelf, "the shelf does not reach (0,-5) on the axis");

        // A slope. Walking outward along an axis, the flank must fall in small
        // steps all the way to the toe: the three-ring apron dropped 56 and then
        // 96 units at a stroke, which is exactly the terrace the eye reads as
        // construction. 40 leaves headroom over the ~33 the ramp actually uses.
        let mut previous: Option<i16> = None;
        let mut flank_cells = 0;
        for d in 4..=11i32 {
            let h = at(d, 0);
            if h == shelf {
                continue; // still on the shelf; the fringe decides where it ends
            }
            assert!(h < 0, "flank cell at radius {d} stands at {h}, above the calm sea");
            assert!(h > -600, "the flank stops before radius {d}: still at the sea floor");
            if let Some(prev) = previous {
                assert!(h <= prev, "the flank rises again at radius {d}: {h} after {prev}");
                assert!(
                    prev - h <= 40,
                    "the flank drops {} units into radius {d} — that is a terrace, not a slope",
                    prev - h
                );
            }
            previous = Some(h);
            flank_cells += 1;
        }
        assert!(flank_cells >= 4, "only {flank_cells} flank cells — the apron barely exists");

        // And it stops. Beyond the apron the sea floor is untouched, which is
        // what keeps the pedestal a feature rather than a continent.
        assert_eq!(at(12, 0), -600, "the apron reaches past its own outer radius");
    }

    #[test]
    fn the_spawn_shelf_founds_satellites() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for _ in 0..200 {
            w.tick(&[]);
        }
        for player in 0..PLAYERS {
            let alive =
                w.settlements.iter().filter(|s| s.alive() && s.owner == player as u8).count();
            assert!(alive >= 2, "player {player} has {alive} settlement(s) at tick 200");
        }
    }

    /// The pedestal is a promise about *every* map, not one seed: on each
    /// shipped terrain type the spawns must stand, hold influence, and still
    /// be standing after the first waves of physics.
    #[test]
    fn spawns_hold_influence_on_every_terrain_and_seed() {
        for terrain in [
            crate::world::TERRAIN_ARCHIPELAGO,
            crate::world::TERRAIN_PANGAEA,
            crate::world::TERRAIN_VOLCANO,
        ] {
            for seed in [0x5EEDu32, 1, 7, 99] {
                let mut w = World::boxed();
                w.init(&MapConfig { seed, terrain, ..MapConfig::DEFAULT });
                for s in 0..PLAYERS {
                    assert!(
                        footprint_still_flat(&w, &w.settlements[s]),
                        "terrain {terrain} seed {seed:#x}: spawn {s} is not flat at tick 0"
                    );
                }
                for _ in 0..600 {
                    w.tick(&[]);
                }
                assert_eq!(w.outcome, 0, "terrain {terrain} seed {seed:#x}: decided by tick 600");
                let held = influence_held(&w);
                assert!(
                    held[0] > 0 && held[1] > 0,
                    "terrain {terrain} seed {seed:#x}: a spawn lost all influence by tick 600"
                );
            }
        }
    }
}
