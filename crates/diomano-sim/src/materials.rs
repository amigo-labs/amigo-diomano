//! The material interaction matrix, granular movement and vegetation.
//! HANDOFF §4.4.
//!
//! Not a physics model — a per-cell integer state machine, cheap and
//! bit-reproducible.
//!
//! # Why this is a table
//!
//! §4.4 is a table in the spec and it is a table here. A tree of hardcoded
//! branches would work today and would then acquire an ordering bug the first
//! time a row is inserted in the middle, because the ordering would live in
//! control flow rather than in data. [`INTERACTIONS`] is the spec's rows in the
//! spec's order; [`apply_rules`] is nine lines and knows nothing about lava.
//!
//! Neighbour reads are hoisted out of the rules entirely: the one row that needs
//! them ("lava adjacent to or under water") reads a precomputed [`World::water_near`]
//! field, so a rule is always a pure function of one cell.

use crate::world::{
    HEIGHT_MAX, HEIGHT_MIN, MAT_ASH, MAT_ROCK, MAT_SAND, MAT_SOIL, MAT_SWAMP, N, TERRACE, World,
    idx, mat_bit, neighbour_flat,
};

/// Angle of repose, in height units (§4.4 `[START]`).
pub const REPOSE_SAND: i32 = 24;
pub const REPOSE_ASH: i32 = 16;
/// Ticks a cell must stay dry and bare before fertility starts to decay.
pub const DRY_DECAY_AFTER: i32 = 600;

/// A field the rule engine can read or write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    Height,
    Water,
    Lava,
    Material,
    Fertility,
    Vegetation,
    Sediment,
    /// Largest outgoing water flow last tick (set by the water pass).
    Erode,
    /// Consecutive ticks with neither water nor vegetation.
    DryTicks,
    /// `max(water, water of the four neighbours)`.
    ///
    /// Writable, unusually: reducing it removes that much water from the cell
    /// and then from its neighbours in the fixed N, E, S, W order. That is what
    /// lets §4.4's "water -= 48" mean "the water it met" for lava cooling on a
    /// shoreline, where the lava cell itself is dry.
    WaterNear,
    /// `tick % 8`, so "every 8 ticks" is a predicate rather than control flow.
    TickMod8,
    /// `tick % 60`.
    TickMod60,
}

/// A comparison in a rule's condition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmp {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
    /// The field's value, read as a material id, is in the bitmask.
    InSet,
}

/// Where an action's operand comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Src {
    Const(i32),
    Field(Field),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Add,
    Set,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pred {
    pub field: Field,
    pub cmp: Cmp,
    pub value: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Act {
    pub field: Field,
    pub op: Op,
    pub src: Src,
    /// Upper bound taken from another field, e.g. vegetation capped at fertility.
    pub cap: Option<Field>,
}

/// Up to four ANDed predicates and four actions per row: enough for every row in
/// §4.4 with room to spare, and small enough that a rule stays readable.
pub const MAX_PREDS: usize = 4;
pub const MAX_ACTS: usize = 4;

#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub name: &'static str,
    pub preds: [Option<Pred>; MAX_PREDS],
    pub acts: [Option<Act>; MAX_ACTS],
}

const fn p(field: Field, cmp: Cmp, value: i32) -> Option<Pred> {
    Some(Pred { field, cmp, value })
}

const fn a(field: Field, op: Op, src: Src) -> Option<Act> {
    Some(Act { field, op, src, cap: None })
}

const fn a_cap(field: Field, op: Op, src: Src, cap: Field) -> Option<Act> {
    Some(Act { field, op, src, cap: Some(cap) })
}

/// The §4.4 interaction matrix, in the spec's row order with one documented
/// exception noted on the rules themselves.
///
/// Rows are evaluated in order and see each other's effects within a tick, which
/// is why the order is part of the data rather than an implementation detail.
pub const INTERACTIONS: &[Rule] = &[
    Rule {
        name: "erosion over sand",
        preds: [
            p(Field::Erode, Cmp::Gt, 32),
            p(Field::Material, Cmp::Eq, MAT_SAND as i32),
            None,
            None,
        ],
        acts: [
            a(Field::Height, Op::Add, Src::Const(-2)),
            a(Field::Sediment, Op::Add, Src::Const(2)),
            None,
            None,
        ],
    },
    Rule {
        name: "erosion over ash",
        preds: [
            p(Field::Erode, Cmp::Gt, 32),
            p(Field::Material, Cmp::Eq, MAT_ASH as i32),
            None,
            None,
        ],
        acts: [
            a(Field::Height, Op::Add, Src::Const(-3)),
            a(Field::Sediment, Op::Add, Src::Const(3)),
            None,
            None,
        ],
    },
    // "eroding flow over rock — no effect". Rock is the erosion-proof material,
    // which is why it has no row: the absence is the rule.
    //
    // The next two rows are lifted above the lava/water row, which is the one
    // deviation from the spec's printed order. Cooling zeroes `lava`, so with
    // the printed order lava that arrives on a vegetated shore and cools in the
    // same tick would never burn anything. Burn first, then cool.
    Rule {
        name: "lava burns vegetation",
        preds: [p(Field::Lava, Cmp::Gt, 0), p(Field::Vegetation, Cmp::Gt, 0), None, None],
        acts: [
            a(Field::Vegetation, Op::Set, Src::Const(0)),
            a(Field::Fertility, Op::Add, Src::Const(-64)),
            None,
            None,
        ],
    },
    Rule {
        name: "lava fuses sand",
        preds: [
            p(Field::Lava, Cmp::Gt, 0),
            p(Field::Material, Cmp::Eq, MAT_SAND as i32),
            None,
            None,
        ],
        acts: [a(Field::Material, Op::Set, Src::Const(MAT_ROCK as i32)), None, None, None],
    },
    Rule {
        // The generative rule. Lava is a construction verb (§4.4): this row is
        // the only way to create permanent new land, and with sea level cycling
        // it is the counter-play to losing it.
        name: "lava meets water and becomes rock",
        preds: [p(Field::Lava, Cmp::Gt, 0), p(Field::WaterNear, Cmp::Ge, 16), None, None],
        acts: [
            a(Field::Material, Op::Set, Src::Const(MAT_ROCK as i32)),
            a(Field::Height, Op::Add, Src::Field(Field::Lava)),
            // Written through `WaterNear`, not `Water`: lava that cools on a
            // shoreline is standing on a dry cell, and taking the 48 units from
            // its own (zero) depth would make the reaction free.
            a(Field::WaterNear, Op::Add, Src::Const(-48)),
            a(Field::Lava, Op::Set, Src::Const(0)),
        ],
    },
    Rule {
        name: "sediment builds soil",
        preds: [
            p(Field::Sediment, Cmp::Ge, 128),
            p(Field::Material, Cmp::InSet, (mat_bit(MAT_ROCK) | mat_bit(MAT_SAND)) as i32),
            None,
            None,
        ],
        acts: [
            a(Field::Material, Op::Set, Src::Const(MAT_SOIL as i32)),
            a(Field::Fertility, Op::Add, Src::Const(32)),
            a(Field::Sediment, Op::Add, Src::Const(-128)),
            None,
        ],
    },
    Rule {
        name: "bare dry soil loses fertility",
        preds: [
            p(Field::DryTicks, Cmp::Ge, DRY_DECAY_AFTER),
            p(Field::TickMod60, Cmp::Eq, 0),
            p(Field::Fertility, Cmp::Gt, 0),
            None,
        ],
        acts: [a(Field::Fertility, Op::Add, Src::Const(-1)), None, None, None],
    },
    Rule {
        name: "exhausted soil becomes sand",
        preds: [
            p(Field::DryTicks, Cmp::Ge, DRY_DECAY_AFTER),
            p(Field::Fertility, Cmp::Eq, 0),
            p(Field::Material, Cmp::Eq, MAT_SOIL as i32),
            None,
        ],
        acts: [a(Field::Material, Op::Set, Src::Const(MAT_SAND as i32)), None, None, None],
    },
];

/// Vegetation growth (§4.1 pass 7, §4.4 row 8).
///
/// Split out from [`INTERACTIONS`] because the tick pass order puts it in its
/// own pass. Same engine, same data shape.
pub const VEGETATION: &[Rule] = &[Rule {
    name: "vegetation grows on damp fertile soil",
    preds: [
        p(Field::Water, Cmp::Ge, 1),
        p(Field::Water, Cmp::Le, 48),
        p(Field::Material, Cmp::Eq, MAT_SOIL as i32),
        p(Field::TickMod8, Cmp::Eq, 0),
    ],
    acts: [a_cap(Field::Vegetation, Op::Add, Src::Const(1), Field::Fertility), None, None, None],
}];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

#[inline]
fn read(w: &World, c: usize, f: Field) -> i32 {
    match f {
        Field::Height => i32::from(w.height[c]),
        Field::Water => i32::from(w.water[c]),
        Field::Lava => i32::from(w.lava[c]),
        Field::Material => i32::from(w.material[c]),
        Field::Fertility => i32::from(w.fertility[c]),
        Field::Vegetation => i32::from(w.vegetation[c]),
        Field::Sediment => i32::from(w.sediment[c]),
        Field::Erode => i32::from(w.erode[c]),
        Field::DryTicks => i32::from(w.dry_ticks[c]),
        Field::WaterNear => i32::from(w.water_near[c]),
        Field::TickMod8 => (w.tick % 8) as i32,
        Field::TickMod60 => (w.tick % 60) as i32,
    }
}

#[inline]
fn write(w: &mut World, c: usize, f: Field, v: i32) {
    // Every field clamps to its own storage range, which is where "floor 0" and
    // "capped at 255" in the spec's table come from — no rule has to say it.
    match f {
        Field::Height => {
            w.height[c] = v.clamp(i32::from(HEIGHT_MIN), i32::from(HEIGHT_MAX)) as i16;
        }
        Field::Water => w.water[c] = v.clamp(0, i32::from(i16::MAX)) as i16,
        Field::Lava => w.lava[c] = v.clamp(0, 255) as u8,
        Field::Material => w.material[c] = v.clamp(0, MAT_SWAMP as i32) as u8,
        Field::Fertility => w.fertility[c] = v.clamp(0, 255) as u8,
        Field::Vegetation => w.vegetation[c] = v.clamp(0, 255) as u8,
        Field::Sediment => w.sediment[c] = v.clamp(0, 255) as u8,
        Field::DryTicks => w.dry_ticks[c] = v.clamp(0, i32::from(u16::MAX)) as u16,
        Field::WaterNear => consume_nearby_water(w, c, v),
        // Read-only fields. Writing one is a bug in a rule, not a runtime case.
        Field::Erode | Field::TickMod8 | Field::TickMod60 => {}
    }
}

/// Apply a reduction written through [`Field::WaterNear`].
///
/// Takes from the cell first, then its neighbours in the fixed N, E, S, W order
/// until the amount is exhausted. A neighbour across a face boundary is a ghost
/// cell, so the removal lands on a copy and the real cell keeps its water — an
/// accepted inaccuracy at seams for a rule that destroys water rather than
/// moving it, and deterministic either way.
fn consume_nearby_water(w: &mut World, c: usize, target: i32) {
    let mut remaining = i32::from(w.water_near[c]) - target;
    if remaining <= 0 {
        return;
    }
    for cell in core::iter::once(c).chain((0..4usize).map(|dir| neighbour_flat(c, dir))) {
        if remaining <= 0 {
            break;
        }
        let take = remaining.min(i32::from(w.water[cell]));
        if take <= 0 {
            continue;
        }
        w.water[cell] -= take as i16;
        remaining -= take;
    }
    w.water_near[c] = target.max(0) as i16;
}

#[inline]
fn holds(w: &World, c: usize, pred: &Pred) -> bool {
    let v = read(w, c, pred.field);
    match pred.cmp {
        Cmp::Gt => v > pred.value,
        Cmp::Ge => v >= pred.value,
        Cmp::Lt => v < pred.value,
        Cmp::Le => v <= pred.value,
        Cmp::Eq => v == pred.value,
        Cmp::InSet => (0..32).contains(&v) && (pred.value & (1 << v)) != 0,
    }
}

/// Evaluate a rule table against one cell, in table order.
pub fn apply_rules(w: &mut World, c: usize, rules: &[Rule]) {
    for rule in rules {
        if !rule.preds.iter().flatten().all(|pred| holds(w, c, pred)) {
            continue;
        }
        for act in rule.acts.iter().flatten() {
            let operand = match act.src {
                Src::Const(k) => k,
                Src::Field(f) => read(w, c, f),
            };
            let mut next = match act.op {
                Op::Add => read(w, c, act.field) + operand,
                Op::Set => operand,
            };
            if let Some(cap) = act.cap {
                next = next.min(read(w, c, cap));
            }
            write(w, c, act.field, next);
        }
    }
}

/// True when no rule in `rules` can fire this tick, whatever the cell holds.
///
/// A rule with a tick predicate — `TickMod8 == 0`, `TickMod60 == 0` — is off
/// for every cell on the ticks where that predicate is false, and if every rule
/// in the table carries one that is false now, the whole pass is a no-op that
/// still visits 24,576 cells. `VEGETATION` is exactly that table on seven of
/// eight ticks. Derived from the data rather than hard-coded, so a rule added
/// without a tick predicate turns the skip off by itself.
///
/// The tick fields read `w.tick` and nothing else, so the cell passed to
/// `holds` is irrelevant; zero is as good as any.
fn table_dormant(w: &World, rules: &[Rule]) -> bool {
    rules.iter().all(|rule| {
        rule.preds
            .iter()
            .flatten()
            .any(|p| matches!(p.field, Field::TickMod8 | Field::TickMod60) && !holds(w, 0, p))
    })
}

/// Could any row of [`INTERACTIONS`] fire on this cell?
///
/// `apply_rules` already stops at a rule's first false predicate, so what a
/// cell that nothing touches pays for is the interpreter itself — the `Field`
/// match, the `Option` flattening, the `Cmp` match — eight times over. This is
/// the table's gating predicates restated as straight-line code, so that only
/// cells with a chance of changing enter the interpreter at all. It halved the
/// most expensive pass in the tick.
///
/// # Why this is exact
///
/// If no rule fires, no field changes, so evaluating every rule against the
/// cell's *initial* state is exact by induction over the table. The gate must
/// therefore be true whenever some rule's predicates all hold initially — it is
/// the disjunction, row by row, of a predicate that row needs:
///
/// - rows 1–2, erosion over sand / ash: `Erode > 32`
/// - rows 3–5, the three lava rows: `Lava > 0`
/// - row 6, sediment builds soil: `Sediment >= 128`
/// - row 7, bare dry soil loses fertility: `DryTicks >= 600`, `TickMod60 == 0`,
///   `Fertility > 0` — all three, because with `DryTicks` alone every bare cell
///   on the planet would pass on every tick
/// - row 8, exhausted soil becomes sand: `DryTicks >= 600`, `Fertility == 0`,
///   `Material == soil`
///
/// **Adding a row to `INTERACTIONS` means adding a term here.**
/// `the_cell_gate_is_implied_by_the_table` fails otherwise, and
/// `gated_interactions_match_the_unfiltered_pass` is the end-to-end check.
#[inline]
fn interactions_may_fire(w: &World, c: usize) -> bool {
    if w.erode[c] > 32 || w.lava[c] > 0 || w.sediment[c] >= 128 {
        return true;
    }
    if i32::from(w.dry_ticks[c]) < DRY_DECAY_AFTER {
        return false;
    }
    (w.tick.is_multiple_of(60) && w.fertility[c] > 0)
        || (w.fertility[c] == 0 && w.material[c] == MAT_SOIL)
}

/// Material interactions, single pass (§4.1 pass 5).
pub fn interactions(w: &mut World) {
    interactions_impl(w, true);
}

/// [`interactions`] without the cell gate, for the test that proves the gate
/// changes nothing.
#[cfg(test)]
fn interactions_unfiltered(w: &mut World) {
    interactions_impl(w, false);
}

fn interactions_impl(w: &mut World, gated: bool) {
    if table_dormant(w, INTERACTIONS) {
        // Never true for this table — its first row has no tick predicate —
        // but the mechanism is the same one `vegetation` relies on, and stating
        // it here is what keeps the two passes symmetric.
        return;
    }
    compute_water_near(w);
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                // The dryness bookkeeping below stays in this loop, gated or
                // not: `consume_nearby_water` takes water from *neighbours*, and
                // a neighbour earlier in scan order has already read its own
                // water for the counter. Splitting the loop would change it.
                if !gated || interactions_may_fire(w, c) {
                    apply_rules(w, c, INTERACTIONS);
                }
                // Dryness bookkeeping feeds the last two rows. Updated after the
                // rules so a cell that was watered this tick reads as wet for a
                // full tick before its counter restarts.
                if w.vegetation[c] == 0 && w.water[c] == 0 {
                    w.dry_ticks[c] = w.dry_ticks[c].saturating_add(1);
                } else {
                    w.dry_ticks[c] = 0;
                }
            }
        }
    }
}

/// `max(water, water of the four neighbours)`, so "adjacent to or under water"
/// is a plain per-cell predicate. Reads the ghost ring, so it is correct at face
/// boundaries with no seam check.
///
/// Only cells that actually hold lava are filled: the sole rule that reads this
/// field also requires `Lava > 0`, and a planet with one vent on it should not
/// pay for four extra reads on all 24,576 cells every tick.
fn compute_water_near(w: &mut World) {
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                if w.lava[c] == 0 {
                    w.water_near[c] = 0;
                    continue;
                }
                let mut m = w.water[c];
                for dir in 0..4usize {
                    m = m.max(w.water[neighbour_flat(c, dir)]);
                }
                w.water_near[c] = m;
            }
        }
    }
}

/// Vegetation growth, single pass (§4.1 pass 7).
///
/// Fertility is potential; vegetation is what actually grew (§3.7). Keeping them
/// separate is what makes regrowth a recovery mechanic instead of a permanent
/// loss — burn a forest and the fertility that survives regrows it.
pub fn vegetation(w: &mut World) {
    if table_dormant(w, VEGETATION) {
        return;
    }
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                apply_rules(w, idx(face, x, y), VEGETATION);
            }
        }
    }
}

/// Granular movement, checkerboard (§4.1 pass 6).
///
/// Sand and ash move to a lower neighbour when the height difference exceeds the
/// angle of repose. Rock and soil do not move.
pub fn granular(w: &mut World) {
    for parity in 0..2usize {
        granular_half(w, parity);
        w.apply_seam_flux_i16(crate::world::FluxField::Height);
        w.ghost_copy_flow_fields();
    }
}

fn granular_half(w: &mut World, parity: usize) {
    for face in 0..6usize {
        for y in 0..N {
            // The cells of this parity, in the same order a full scan with a
            // parity test visited them, without the test.
            for x in ((parity + y) & 1..N).step_by(2) {
                let a = idx(face, x, y);
                let repose = match w.material[a] {
                    MAT_SAND => REPOSE_SAND,
                    MAT_ASH => REPOSE_ASH,
                    _ => continue,
                };
                for dir in 0..4usize {
                    let b = neighbour_flat(a, dir);
                    let diff = i32::from(w.height[a]) - i32::from(w.height[b]);
                    if diff <= repose {
                        continue;
                    }
                    // /4 keeps the pair from crossing back over the repose angle
                    // and oscillating, exactly as the water term does.
                    let moved = (diff - repose) / 4;
                    if moved <= 0 {
                        continue;
                    }
                    w.height[a] -= moved as i16;
                    let material = w.material[a];
                    match seam_entry(face, x, y, dir) {
                        Some(k) => w.seam_flux[k] += moved,
                        None => {
                            w.height[b] = w.height[b].saturating_add(moved as i16);
                            // The slope is now made of what slid down it.
                            if moved >= TERRACE as i32 / 4 {
                                w.material[b] = material;
                            }
                        }
                    }
                }
            }
        }
    }
}

#[inline]
const fn seam_entry(face: usize, x: usize, y: usize, dir: usize) -> Option<usize> {
    use crate::seams::{DIR_E, DIR_N, DIR_S};
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MapConfig, TERRAIN_PANGAEA};

    fn flat_world(seed: u32) -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.seed = seed;
        cfg.terrain = TERRAIN_PANGAEA;
        let mut w = World::boxed();
        w.init(&cfg);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 500;
                    w.water[c] = 0;
                    w.lava[c] = 0;
                    w.material[c] = MAT_ROCK;
                    w.vegetation[c] = 0;
                    w.sediment[c] = 0;
                    w.dry_ticks[c] = 0;
                }
            }
        }
        w.ghost_copy_all();
        w
    }

    #[test]
    fn lava_plus_water_yields_rock() {
        let mut w = flat_world(1);
        let c = idx(4, 32, 32);
        let n = idx(4, 33, 32);
        w.material[c] = MAT_SAND;
        w.lava[c] = 90;
        w.water[n] = 200; // adjacent water, well over the 16-unit threshold
        w.ghost_copy_all();

        let height_before = w.height[c];
        interactions(&mut w);

        assert_eq!(w.lava[c], 0, "lava did not cool");
        assert_eq!(w.material[c], MAT_ROCK, "cooled lava is not rock");
        assert_eq!(
            w.height[c],
            height_before + 90,
            "the lava's volume did not become land — lava is a construction verb"
        );
        assert_eq!(w.water[n], 200 - 48, "the reaction did not consume the water it met");
    }

    #[test]
    fn lava_under_water_also_yields_rock() {
        // "adjacent to *or under*" — the same row must fire for a submerged vent.
        let mut w = flat_world(2);
        let c = idx(1, 10, 10);
        w.lava[c] = 40;
        w.water[c] = 300;
        w.ghost_copy_all();
        interactions(&mut w);
        assert_eq!(w.lava[c], 0);
        assert_eq!(w.material[c], MAT_ROCK);
        assert_eq!(w.water[c], 300 - 48, "a submerged vent took the water from elsewhere");
    }

    #[test]
    fn lava_burns_vegetation_in_the_tick_it_cools() {
        let mut w = flat_world(3);
        let c = idx(2, 20, 20);
        w.material[c] = MAT_SOIL;
        w.vegetation[c] = 200;
        w.fertility[c] = 200;
        w.lava[c] = 50;
        w.water[idx(2, 21, 20)] = 100;
        w.ghost_copy_all();
        interactions(&mut w);
        assert_eq!(w.vegetation[c], 0, "vegetation survived a lava flow");
        assert_eq!(w.fertility[c], 200 - 64, "fertility did not take the hit");
        assert_eq!(w.lava[c], 0, "lava did not cool in the same tick");
    }

    #[test]
    fn rock_is_erosion_proof_and_sand_is_not() {
        let mut w = flat_world(4);
        let rock = idx(0, 5, 5);
        let sand = idx(0, 7, 5);
        let ash = idx(0, 9, 5);
        w.material[sand] = MAT_SAND;
        w.material[ash] = MAT_ASH;
        for c in [rock, sand, ash] {
            w.erode[c] = 200;
        }
        let before = [w.height[rock], w.height[sand], w.height[ash]];
        interactions(&mut w);
        assert_eq!(w.height[rock], before[0], "rock eroded");
        assert_eq!(w.height[sand], before[1] - 2);
        assert_eq!(w.sediment[sand], 2);
        assert_eq!(w.height[ash], before[2] - 3);
        assert_eq!(w.sediment[ash], 3);
    }

    #[test]
    fn sediment_builds_soil_and_raises_fertility() {
        let mut w = flat_world(5);
        let c = idx(3, 12, 12);
        w.material[c] = MAT_SAND;
        w.sediment[c] = 200;
        w.fertility[c] = 10;
        interactions(&mut w);
        assert_eq!(w.material[c], MAT_SOIL);
        assert_eq!(w.fertility[c], 42);
        assert_eq!(w.sediment[c], 200 - 128);
    }

    #[test]
    fn vegetation_grows_only_on_damp_fertile_soil_and_is_capped_by_fertility() {
        let mut w = flat_world(6);
        let good = idx(4, 4, 4);
        let too_deep = idx(4, 6, 4);
        let barren = idx(4, 8, 4);
        for c in [good, too_deep, barren] {
            w.material[c] = MAT_SOIL;
            w.water[c] = 20;
        }
        w.fertility[good] = 3;
        w.water[too_deep] = 400;
        w.fertility[too_deep] = 200;
        w.fertility[barren] = 0;

        w.tick = 0;
        for _ in 0..40 {
            vegetation(&mut w);
            w.tick += 8; // every 8 ticks (§4.4)
        }
        assert_eq!(w.vegetation[good], 3, "growth is not capped at fertility");
        assert_eq!(w.vegetation[too_deep], 0, "vegetation grew under deep water");
        assert_eq!(w.vegetation[barren], 0, "vegetation grew without fertility");
    }

    #[test]
    fn vegetation_only_grows_on_the_eight_tick_boundary() {
        let mut w = flat_world(7);
        let c = idx(5, 3, 3);
        w.material[c] = MAT_SOIL;
        w.water[c] = 10;
        w.fertility[c] = 100;
        w.tick = 3;
        vegetation(&mut w);
        assert_eq!(w.vegetation[c], 0);
        w.tick = 8;
        vegetation(&mut w);
        assert_eq!(w.vegetation[c], 1);
    }

    #[test]
    fn bare_dry_soil_eventually_reverts_to_sand() {
        let mut w = flat_world(8);
        let c = idx(0, 40, 40);
        w.material[c] = MAT_SOIL;
        w.fertility[c] = 3;
        w.water[c] = 0;
        w.vegetation[c] = 0;
        for t in 0..(DRY_DECAY_AFTER as u32 + 60 * 6) {
            w.tick = t;
            // Keep the cell dry; the sea-level pass is not running here.
            interactions(&mut w);
        }
        assert_eq!(w.fertility[c], 0, "fertility never decayed");
        assert_eq!(w.material[c], MAT_SAND, "exhausted soil did not revert");
    }

    #[test]
    fn dry_counter_resets_when_a_cell_is_watered() {
        let mut w = flat_world(9);
        let c = idx(0, 2, 2);
        for t in 0..100u32 {
            w.tick = t;
            interactions(&mut w);
        }
        assert_eq!(w.dry_ticks[c], 100);
        w.water[c] = 5;
        w.tick = 100;
        interactions(&mut w);
        assert_eq!(w.dry_ticks[c], 0);
    }

    #[test]
    fn granular_movement_respects_the_angle_of_repose() {
        let mut w = flat_world(10);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    w.material[idx(face, x, y)] = MAT_SAND;
                }
            }
        }
        // A sand spike far above its neighbours.
        let c = idx(4, 32, 32);
        w.height[c] = 2000;
        w.ghost_copy_all();

        let total_before = total_height(&w);
        for _ in 0..400 {
            w.ghost_copy_all();
            granular(&mut w);
        }
        assert_eq!(total_height(&w), total_before, "granular movement lost matter");

        // Every remaining slope must be inside the repose angle.
        for y in 1..N - 1 {
            for x in 1..N - 1 {
                let a = idx(4, x, y);
                for dir in 0..4usize {
                    let b = neighbour_flat(a, dir);
                    let d = i32::from(w.height[a]) - i32::from(w.height[b]);
                    assert!(
                        d <= REPOSE_SAND + 4,
                        "slope {d} at ({x},{y}) exceeds the sand repose angle"
                    );
                }
            }
        }
    }

    #[test]
    fn rock_and_soil_do_not_slide() {
        let mut w = flat_world(11);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    w.material[idx(face, x, y)] = if face == 4 { MAT_ROCK } else { MAT_SOIL };
                }
            }
        }
        let c = idx(4, 20, 20);
        w.height[c] = 4000;
        w.ghost_copy_all();
        for _ in 0..50 {
            w.ghost_copy_all();
            granular(&mut w);
        }
        assert_eq!(w.height[c], 4000, "a rock spire slumped");
    }

    fn total_height(w: &World) -> i64 {
        let mut t = 0i64;
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    t += i64::from(w.height[idx(face, x, y)]);
                }
            }
        }
        t
    }

    #[test]
    fn dormant_tables_are_recognised_from_their_predicates() {
        let mut w = flat_world(3);
        for tick in 0..130u32 {
            w.tick = tick;
            assert_eq!(table_dormant(&w, VEGETATION), tick % 8 != 0, "tick {tick}");
            assert!(!table_dormant(&w, INTERACTIONS), "INTERACTIONS has an untimed row");
        }
        // One timed row does not put a table to sleep while an untimed one is in it.
        let mixed = [VEGETATION[0], INTERACTIONS[0]];
        w.tick = 3;
        assert!(!table_dormant(&w, &mixed));
        assert!(table_dormant(&w, &[]), "an empty table has nothing to run");
    }

    #[test]
    fn the_cell_gate_is_implied_by_the_table() {
        // For every rule, "all predicates hold on the initial state" must imply
        // the gate. Sampled at the thresholds the rules use, where an off-by-one
        // in the gate would hide.
        let mut w = flat_world(5);
        let mut rng = crate::hash::Rng::new(0xC0FFEE);
        let pick = |rng: &mut crate::hash::Rng, v: &[i32]| v[rng.below(v.len() as u32) as usize];
        let c = idx(2, 10, 10);
        for _ in 0..200_000 {
            w.tick = pick(&mut rng, &[0, 1, 59, 60, 120, 480]) as u32;
            w.erode[c] = pick(&mut rng, &[0, 31, 32, 33, 255]) as u8;
            w.lava[c] = pick(&mut rng, &[0, 0, 1, 255]) as u8;
            w.sediment[c] = pick(&mut rng, &[0, 127, 128, 255]) as u8;
            w.dry_ticks[c] = pick(&mut rng, &[0, 599, 600, 601, 65535]) as u16;
            w.fertility[c] = pick(&mut rng, &[0, 0, 1, 140, 255]) as u8;
            w.material[c] = pick(&mut rng, &[0, 1, 2, 3, 4]) as u8;
            w.vegetation[c] = pick(&mut rng, &[0, 1, 200]) as u8;
            w.water[c] = pick(&mut rng, &[0, 1, 15, 16, 48, 49, 500]) as i16;
            w.water_near[c] = pick(&mut rng, &[0, 15, 16, 500]) as i16;
            let fires = INTERACTIONS
                .iter()
                .any(|rule| rule.preds.iter().flatten().all(|p| holds(&w, c, p)));
            if fires {
                assert!(
                    interactions_may_fire(&w, c),
                    "a rule fires but the gate is shut: tick {} erode {} lava {} sed {} dry {} fert {} mat {}",
                    w.tick,
                    w.erode[c],
                    w.lava[c],
                    w.sediment[c],
                    w.dry_ticks[c],
                    w.fertility[c],
                    w.material[c]
                );
            }
        }
    }

    #[test]
    fn gated_interactions_match_the_unfiltered_pass() {
        // Two identical worlds, ticked identically, then one runs the gated pass
        // and the other the unfiltered one, at the ticks the gate treats
        // differently. Lava, sediment and exhausted soil are planted first so
        // every row of the table actually has something to do.
        for &(seed, terrain) in &[(0x5EEDu32, 0u8), (7, 1), (99, 2)] {
            let mut cfg = MapConfig::DEFAULT;
            cfg.seed = seed;
            cfg.terrain = terrain;
            let mut a = World::boxed();
            let mut b = World::boxed();
            a.init(&cfg);
            b.init(&cfg);
            let plant = |w: &mut World| {
                for face in 0..6usize {
                    for k in 0..N {
                        let c = idx(face, k, (k * 7) % N);
                        if w.height[c] > 0 {
                            w.lava[c] = 40;
                        }
                        let d = idx(face, (k * 5) % N, k);
                        w.sediment[d] = 200;
                        let e = idx(face, (k * 3) % N, (k * 11) % N);
                        w.dry_ticks[e] = 700;
                        if k % 2 == 0 {
                            w.fertility[e] = 0;
                            w.material[e] = MAT_SOIL;
                        }
                    }
                }
                w.ghost_copy_all();
            };
            for _ in 0..300 {
                a.tick(&[]);
                b.tick(&[]);
            }
            plant(&mut a);
            plant(&mut b);
            assert_eq!(a.state_hash(), b.state_hash());
            // Ticks 300, 301 and then 359: %60 of 0, 1 and 59.
            for step in [0usize, 1, 58] {
                for _ in 0..step {
                    a.tick(&[]);
                    b.tick(&[]);
                }
                a.ghost_copy_all();
                b.ghost_copy_all();
                interactions(&mut a);
                interactions_unfiltered(&mut b);
                assert_eq!(
                    a.state_hash(),
                    b.state_hash(),
                    "seed {seed:#x} terrain {terrain} tick {}",
                    a.tick
                );
                assert!(
                    a.dry_ticks.iter().eq(b.dry_ticks.iter()),
                    "dry_ticks diverged at tick {}",
                    a.tick
                );
                assert!(a.water_near.iter().eq(b.water_near.iter()));
            }
        }
    }

    #[test]
    fn every_rule_row_is_reachable() {
        // A row whose predicates can never all hold is dead data and would be
        // invisible without this. Checks the shape, not the semantics.
        for rule in INTERACTIONS.iter().chain(VEGETATION.iter()) {
            assert!(
                rule.preds.iter().flatten().count() > 0,
                "rule '{}' has no condition and would fire on every cell",
                rule.name
            );
            assert!(rule.acts.iter().flatten().count() > 0, "rule '{}' does nothing", rule.name);
            for act in rule.acts.iter().flatten() {
                assert!(
                    !matches!(act.field, Field::Erode | Field::TickMod8 | Field::TickMod60),
                    "rule '{}' writes a read-only field",
                    rule.name
                );
            }
        }
    }
}
