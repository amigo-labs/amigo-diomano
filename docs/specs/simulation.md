# Simulation

Split from `docs/HANDOFF.md` §4 (Phase 0). Implemented by
`crates/diomano-sim/src/{world,water,materials,flowfield,walkers,settlements}.rs`.

---

## Tick model

- Fixed **30 Hz** simulation tick. No variable timestep, ever.
- Fixed-point **Q16.16** for walker positions and mana accumulators. Grid fields
  are plain integers in the units of `world.md`.
- No wall-clock time inside the simulation. Tick count is the only clock.
- Render interpolates between the last two sim states; it never advances state.

**Frame budget:** 33.3 ms per frame at 30 Hz, split **12 ms simulation, 21 ms
render and everything else**. If simulation exceeds 12 ms, reduce `N` — never
the tick rate, which would change game feel and invalidate all tuning.

### Pass order

Fixed and load-bearing for determinism. `World::tick` runs exactly this:

```
1.  ghost border copy            (6 x 4 x N, one gather)
2.  command application          (this tick's input)
2a. tide                         [not in HANDOFF §4.1 — see below]
2b. scripted opponent            [not in HANDOFF §4.1 — see below]
3.  water transfer               (checkerboard: even, then odd)
4.  lava transfer                (checkerboard: even, then odd)
5.  material interactions        (single pass)
6.  granular movement            (checkerboard: even, then odd)
7.  vegetation growth            (single pass)
8.  walkers: movement            (fixed walker-id order)
9.  walkers: combat resolution   (see combat.md)
10. settlements: build / decay
11. every 15 ticks: flow field + influence projection
12. mana accrual
13. every 30 ticks: state hash
```

Two passes are additions to §4.1's list and are marked as such in the code:

- **2a, tide.** It must move `sea_level` *before* water transfer reads it,
  otherwise every flood lands a tick late and the flood/water interaction
  depends on which of the two ran first.
  `determinism::tick_order_is_the_order_the_spec_lists` asserts the observable
  consequence: no cell below sea level is left dry within the same tick.
- **2b, scripted opponent.** It emits ordinary `Command`s into a buffer which is
  then applied through `apply_commands` — the same path as human input. It has
  no privileged mutation route into the world, which `ai::the_opponent_never_touches_the_world_directly`
  asserts by hashing before and after.

## Measured cost

`cargo run --release -p diomano-cli -- perf`, N = 64, 24,576 live cells, 600
ticks, archipelago seed `0x5EED`, development container (not the §7.6 reference
floor):

| pass | ms/tick | % of sim |
|---|---:|---:|
| 1 ghost border copy | 0.0118 | 0.8% |
| 2 command application | 0.0004 | 0.0% |
| 2a tide | 0.0146 | 1.0% |
| 3 water transfer | 0.2202 | 14.5% |
| 4 lava transfer | 0.0405 | 2.7% |
| 5 material interactions | 0.6905 | 45.6% |
| 6 granular movement | 0.1597 | 10.6% |
| 7 vegetation growth | 0.2276 | 15.0% |
| 8 walker movement | 0.0010 | 0.1% |
| 9 combat resolution | 0.0230 | 1.5% |
| 10 settlements | 0.0810 | 5.4% |
| 11 flow field + influence | 0.0082 | 0.5% |
| 12 mana accrual | 0.0252 | 1.7% |
| 13 state hash | 0.0103 | 0.7% |
| **simulation total** | **1.5139** | |
| meshing (render budget, not sim) | 0.5984 | 16.1 chunks/tick |

**12.6% of the 12 ms budget.** The rule-table evaluator dominates at 45.6%,
which is the expected shape: it is the only pass that visits every cell and
evaluates eight predicates over it. If the budget ever tightens, that is where
to look first — not at the water solver.

Failure mode 7 in §13 is simulation budget creep: each new field is another
pass over 24k cells at 30 Hz. `just perf` is the instrument; run it before
adding a field, not after.

## Terrain deformation

The core free verb is raise/lower land in discrete terrace steps within a brush
footprint. Terrain change is the *only* mechanism that alters the pathfinding
graph.

Terrain smoothness is the central strategic axis: rolling terrain yields small
settlements that spread fast but are weak; flat terrain yields large fortified
settlements that grow slowly and produce strong walkers. This emerges from one
verb. `settlements::rolling_ground_yields_only_huts_and_flat_ground_yields_citadels`
asserts it as an invariant rather than trusting it to emerge.

**Material conservation** is a mechanic, not an accounting detail. Lowering a
cell fills the hand; raising empties it. **A full hand cannot dig and an empty
hand cannot build** — that is the anti-griefing rule of pillar 4 stated as a
mechanic rather than as a cost, and it is asserted by
`world::an_empty_hand_cannot_build_and_a_full_hand_cannot_dig`.

The hand carries three materials — earth, water, lava — with capacity 4096 units
each `[START]`. Mixing is impossible: switching material requires an empty hand.
The same two verbs (raise, lower) move whatever is held, which is where "carry
water onto lava to make rock at a chosen location" comes from with no new verb.

## Water

**Not a fluid simulation.** Per-cell integer depth, checkerboard two-pass so the
result is scan-order independent while staying deterministic.

```rust
let sa = height[a] + water[a];
let sb = height[b] + water[b];
if sa <= sb { return; }
let mut flow = (sa - sb) / 4;            // /4, not /2: four neighbours; /2 oscillates
flow = flow.min(water[a]);
let drag = 256 - vegetation[a];          // linear vegetation damping
flow = (flow * drag) / 256;
```

Global sea level is a single integer. **Cells below it are pinned to it** by
`water::apply_sea_level` — the ocean is a boundary condition, not a body of
water that relaxes. That is what makes `settles_without_oscillation` converge
rather than merely damp, and it is why a planet-sized basin does not slosh
forever.

### Conservation across a seam

A transfer out of an edge cell targets a *ghost* cell, and ghosts are
overwritten by the next border copy. The naive implementation therefore
destroys every drop that crosses a face boundary, at roughly 1,536 cells' worth
per tick — a leak large enough to drain the oceans and subtle enough to be
mistaken for evaporation.

Instead each such transfer is recorded against the seam entry it crossed
(`World::seam_flux`) and scattered onto the real destination after the pass, and
the ghost ring is refreshed between the two checkerboard halves.
`water::water_is_conserved_across_seams` asserts exact conservation on dry high
ground, where the sea-level boundary condition cannot mask a leak.

### Vegetation damping and the gap

One term, and it makes forests mechanically load-bearing rather than
decorative. The emergent behaviour it is there for:

> An open gap in a forest — a road, a river, an elevation change — channels and
> amplifies a strong current by forcing it into the gap.

**Not special-cased anywhere.** `water::vegetation_damping_channels_flow_through_a_gap`
builds two identical worlds differing only in the vegetation field, and asserts
that cutting a notch in a treeline focuses at least 1.5x more water through the
notch's column. The only code that reads vegetation in the water pass is the
`drag` line above. **Observed, not assumed.**

## Materials

The heart of the simulation. Not a physics model — a per-cell integer state
machine, cheap and bit-reproducible.

**Table-driven, in the spec's row order, in `materials::INTERACTIONS`.** A rule
is `[Option<Pred>; 4]` ANDed against `[Option<Act>; 4]`; the evaluator is nine
lines and knows nothing about lava. Rows are evaluated in order and see each
other's effects within a tick, which is why the order is part of the *data*.

| Condition | Result |
|---|---|
| eroding flow (`> 32`) over `sand` | `height -= 2`, `sediment += 2` |
| eroding flow over `ash` | `height -= 3`, `sediment += 3` |
| eroding flow over `rock` | no row — rock is the erosion-proof material |
| `lava > 0` on `vegetation > 0` | `vegetation = 0`, `fertility -= 64` |
| `lava > 0` on `sand` | `material = rock` |
| `lava > 0` adjacent to or under `water >= 16` | → `rock`, `height += lava`, water −48, `lava = 0` |
| `sediment >= 128` on rock or sand | `material = soil`, `fertility += 32`, `sediment -= 128` |
| dry and bare for 600 ticks | `fertility -= 1` every 60 ticks; at 0, → `sand` |
| `water` in `1..=48` on fertile `soil` | `vegetation += 1` every 8 ticks, capped at `fertility` |

Angle of repose `[START]`: sand 24 units, ash 16.

### Two documented deviations from §4.4's printed order

1. **Burn before cool.** The two "lava on X" rows are lifted above the
   lava/water row. Cooling zeroes `lava`, so in the printed order lava that
   arrives on a vegetated shore and cools in the same tick would never burn
   anything. `materials::lava_burns_vegetation_in_the_tick_it_cools` pins this.
2. **"water -= 48" reads as "the water it met".** Lava cooling on a shoreline
   stands on a *dry* cell, so subtracting 48 from its own depth would make the
   reaction free. The action is written through a `WaterNear` pseudo-field which
   takes from the cell first and then its neighbours in the fixed N, E, S, W
   order. Water removed across a seam lands on a ghost copy and the real cell
   keeps it — an accepted inaccuracy for a rule that *destroys* water rather
   than moving it, and deterministic either way.

**Lava is a construction verb, not a destruction verb.** Because it cools to
rock on water contact it is the only way to create permanent new land, and with
sea level cycling, creating land is the counter-play to losing it. The volcano
is therefore **the most contested resource on the planet** — both gods need the
same crater. Do not balance it as damage.

## Flow field, influence and walkers

**Flow field.** Integer-cost BFS from targets (papal magnet, settlements) over
passable cells, producing a per-cell direction. Neighbour order fixed N, E, S, W.
Recomputed on a fixed **15-tick** boundary, never immediately on terrain change:
immediate recompute would couple the result to event ordering.

`dist` is stored **per player**. With one shared buffer the second player's
rebuild silently overwrites the first's and every consumer reads a field
belonging to the wrong god. That cost 52 KB and removed a real footgun.

**Influence projection.** Projected from settlements over the BFS graph on the
same 15-tick boundary. Each settlement emits `tier_strength * INFLUENCE_REACH`
(reach = 6 cells per strength point `[START]`), decaying by 1 per cell.

Implemented as a **monotone bucket BFS**: contributions decrease by exactly one
per cell, so processing levels from `MAX_CONTRIBUTION` down to 1 visits every
cell at most once and gives the same answer as one Dijkstra per settlement.

```
influence[cell] = clamp(sum_a - sum_b, -127, 127)
```

The important property: **influence is zero-sum.** A cell belongs to one god or
the other and the total is bounded by habitable land, which the tides keep
finite. Gaining influence necessarily means taking it.

Rejected alternative: "whoever last reshaped the cell owns it" — that would make
mana a function of clicking.

**Walkers.** `(face, x: Q16.16, y: Q16.16, strength: u8, hp: i16)`, following the
gradient. With no magnet placed they **seek the largest buildable plateau inside
their own influence and never leave it**; the papal magnet is the only way to
expand beyond it, which is what makes expansion a deliberate act.

Walker slots **interleave between players** (`slot_of(player, n) = n * 2 + player`).
Combat resolves within a cell in id order; if player 0 owned the whole low half
of the id space it would always act first in every contested cell —
deterministic, but a systematic advantage baked into an array layout.

Walker cap `[START]` 512 per player. Walker movement costs 0.001 ms/tick at the
populations reached in the perf run, so the cap is nowhere near binding; it has
not been stress-measured at 512 and remains `[MEASURE]`.

## Settlements and mana

**Build sites are contiguous plateaus of exactly equal height.** Detected by an
O(1)-per-cell dynamic program (`detect_plateaus`).

| Plateau | Tier | Population | Tier strength | Progress threshold |
|---|---|---|---|---|
| 3×3 | hut | 2 | 1 | 60 |
| 5×5 | house | 5 | 2 | 200 |
| 7×7 | fortress | 10 | 4 | 480 |
| 9×9 | citadel | 18 | 7 | 900 |

Build rate 2/tick `[START]`, so a 5×5 becomes a house in 100 ticks — 3.3
seconds, which is the "within seconds" of the Phase 3 DoD, asserted by
`settlements::a_house_appears_within_a_few_seconds`.

**Footprints are claimed largest first**, then in flat-index order within a size.
A single pass would let the 3×3 corner of a flattened 5×5 claim the middle of it
a few cells before the 5×5 became visible, and a player who flattened *more*
ground would get a *smaller* settlement — which inverts the whole wide-versus-tall
axis. This was a real bug caught by `plateau_5x5_produces_house`.

A settlement is razed when progress falls **below zero**, not merely below the
hut threshold: every site starts at zero and has to rise through that range.

**Mana accrues from held habitable territory, not from raw population count.**
This is the deliberate divergence from Populous and the primary snowball fix. A
cell contributes if it is above sea level, is soil or rock, and `influence`
favours that player. Settlement tier is a multiplier, not the base.

Population is self-reinforcing and direct conflict *amplifies* that loop, because
conquest adds population. Habitable territory is bounded and the sea keeps taking
it back, so the mode's core mechanic continuously erodes the leader's advantage.
Treat this as a pillar, not a tuning knob (failure mode 2).

## Bootstrap

Founding requires influence and influence is projected from settlements, so
nothing is ever built from an empty world. `settlements::seed_starting_positions`
places one house per god at the centres of the two opposite faces 4 and 5 —
antipodal, which is as far apart as this topology allows. Populous solved the
same circularity the same way: it simply placed the first hut.
