# diomano — Handoff Specification

> `dio` + `mano` — the god and the hand, which is the entire interface (§8).
> Reads Italian rather than Spanish; deliberate, not a typo.

Browser-based 1v1 god game on a spherical planet. Indirect control only: the player
reshapes terrain and the population acts autonomously, including fighting the
opposing population on contact. Deterministic lockstep multiplayer over WebRTC.
Zero hosting cost inside the Cloudflare Free Tier.

Status: greenfield. Single source of truth for the first implementation pass.
Intended to be split into `docs/specs/*.md` once the skeleton exists (Phase 0).

**Numeric values in this document are one of two kinds and are labelled as such:**

- `[START]` — a starting value chosen here so implementation can proceed. Change it
  freely once measured or playtested. It is not a research result.
- `[MEASURE]` — must be determined empirically before it can be trusted.
- `[TODO]` — not yet determinable; the blocking input is named inline.

---

## 1. Design pillars

Non-negotiable. Every later decision defers to them.

1. **The player is a god, never a unit.** No avatar, no shaman, no direct unit
   commands. The only interface is a hand acting on the world. Modelled on
   Populous 1/2, explicitly *not* Populous: The Beginning, which broke this by
   letting the player steer a shaman directly.
2. **Indirect control is the latency strategy.** Input is intentionally loosely
   coupled to visible response. This is why the genre was chosen: the original
   Populous shipped 1v1 over a null-modem serial link in 1989. Relay RTT of
   60–100 ms is structurally invisible here. Never introduce a mechanic requiring
   frame-accurate response.
3. **The god never attacks directly. The peoples do.** The god's levers are
   terrain, the magnet, and disasters — never an attack order. Walkers fight
   autonomously on contact and reduce enemy settlements over time. The aggression
   is indirect; the conflict is real and between the peoples.
4. **Material is conserved.** What the player removes must go somewhere. This is
   the anti-griefing rule: destruction is never cheaper than construction.
5. **Nature is pressure, not an opponent.** Tides, erosion and eruptions are not
   the boss. They exist to keep habitable land finite, to prevent permanent
   entrenchment, and to push the two peoples toward each other so that contact is
   inevitable rather than optional. Without them, both players could build in
   their own corner and the war would be avoidable.
6. **The planet is the scoreboard.** Territory takes on the aesthetic of the god
   who shaped it. Standings must be readable from the render alone, with no HUD.
7. **Determinism is a design constraint, not an implementation detail.** If a
   feature cannot be made bit-reproducible, the feature changes.

### Non-goals

- No creature/pet companion.
- No pixel-art render path — conflicts with a rotating camera (pixel crawl) and
  with the stylised-realism target. Explicitly abandoned.
- No true fluid dynamics (§4.3).
- No arbitrary CSG terrain destruction.
- No player-issued attack orders, ever (pillar 3).

---

## 2. Design references

| Source | What is taken |
|---|---|
| Populous (1989) | Core loop: flatten land → followers build → power. Tiny verb set. Autonomous walker combat on contact. Self-damaging global powers. Armageddon as stalemate breaker. |
| Populous II (1991) | Three verbs always available; everything else varies per map. |
| Black & White 1 | The hand as the entire interface. No HUD. Gesture-drawn selection. God vs. god duel format. |
| Black & White 2 | Visual target: stylised "toy diorama" — saturated, soft-lit, clean silhouettes. Thrown vs. poured delivery. One-shot pickups. Increased/extreme variants. Territory aesthetic reflecting alignment. |
| From Dust (2011) | The material interaction matrix (§4.4). Lava as a *construction* verb. The hand carries fluids, not just earth. Nature with a wave rhythm. Vegetation as a functional simulation actor. |

**Rejected from From Dust:** totems and tribal-knowledge progression — campaign
objectives that would be arbitrary placed furniture in a symmetric duel. Also
rejected: the continuous float-based erosion model (§4.3), and the single-player
campaign structure.

**Diverged from Populous:** mana is derived from held territory rather than raw
population count (§4.6). See failure mode 2 (§13) for why.

**Balance numbers from the originals must be researched, not invented** (Phase 2
research task). Sources: the original Amiga manual (lemonamiga.com docs), GameFAQs
strategy guides for Populous and Populous II, and popre.net for competitive
multiplayer balance. Numeric balance values are facts, not protectable expression —
do not copy prose, do not use any original assets. Constants defined in *this*
document are diomano's own and need no sourcing.

---

## 3. World model: cubed sphere (quadsphere)

### 3.1 Why not an icosphere

A geodesic/Goldberg sphere has 12 pentagonal cells, breaking the assumption of a
uniform neighbour count. More importantly the core verb is shaping **flat
contiguous square plateaus** with square build sites; a hex grid works against that
mechanic. A cubed sphere keeps square cells and integer indexing.

### 3.2 Topology

Six square integer grids, one per cube face, projected onto the sphere at render
time. **The sphere exists only in the renderer.** The simulation operates on six 2D
integer arrays and knows nothing about a sphere.

```
Face indices: 0 = +x, 1 = -x, 2 = +y, 3 = -y, 4 = +z, 5 = -z
N = 64                       // [START] cells per face edge
S = N + 2                    // stride, includes 1-cell ghost border
index(face, x, y) = (face * S + (y + 1)) * S + (x + 1)
```

Live cells at N=64: `6 * 64 * 64 = 24,576`. N was lowered from an initial guess of
96 because the material matrix (§4.4) adds field passes per tick. Settle it with the
Phase 1 perf test — `[MEASURE]`.

Use tangent-adjusted cube-to-sphere projection (not naive normalisation) to hold
cell-area distortion near cube corners at roughly 1.3:1 instead of ~1.9:1.

### 3.3 Seam table

A cube has 12 edges, each traversable from two sides: **24 seam rules**, computed
once at startup and never touched again.

```rust
struct SeamRule {
    face: u8,       // destination face
    axis: Axis,     // which destination axis the source edge coordinate maps to
    flip: bool,     // is that coordinate reversed
    at_max: bool,   // enter at index 0 or N-1 on the other axis
}
const SEAM: [SeamRule; 24] = /* face * 4 + edge; edge order N, E, S, W */;
```

The rotation is the part to get right: leaving the east edge of `+x` you enter `+y`,
where the direction you called "east" is now "south". Your x-axis becomes their
y-axis.

Required test: walk a closed loop across four faces and assert it returns to the
origin cell, for all 24 entry points.

### 3.4 Ghost borders

Before each simulation tick, copy the boundary rows/columns of neighbouring faces
into each face's ghost border: **24 copy operations per tick**. Every CA pass then
iterates `1..=N` on a plain borderless 2D grid with zero seam checks in the hot
loop. Standard practice in climate and astronomy cubed-sphere codes.

### 3.5 Cube corners

Each of the 8 cube corners is shared by 3 faces, so the diagonal ghost cell at a
face corner is ambiguous.

**Resolution: all cellular-automata rules use the von Neumann (4-neighbour)
neighbourhood only.** Diagonals are never read, so the ambiguity cannot be observed.
Hard rule — do not add a diagonal-reading rule without re-solving corners.

### 3.6 Units

One convention, applied everywhere, to avoid conversion bugs:

```
1 visible terrain terrace = 16 internal height units
height, water, lava are all in the same units and directly comparable
i16 range ±32767 = ±2048 terraces — ample
```

`height + water` is therefore a valid water-surface altitude with no scaling.

### 3.7 State layout

All simulation state is integer, in flat typed arrays owned by Rust.

| Field | Type | Meaning |
|---|---|---|
| `height` | `i16` | terrain altitude in units (§3.6) |
| `water` | `i16` | water depth above terrain, 0 = dry |
| `lava` | `u8` | molten depth, 0 = none |
| `material` | `u8` | rock / sand / soil / ash / swamp |
| `fertility` | `u8` | soil potential, 0–255 |
| `vegetation` | `u8` | actual plant density, 0–255. **Simulation state, not a shader input** |
| `sediment` | `u8` | eroded material in transit / deposited |
| `influence` | `i8` | −127..127, signed territory ownership (§4.5) |

`fertility` and `vegetation` are deliberately separate. Fertility is potential;
vegetation is what actually grew and has mechanical effects (§4.3, §4.7). Vegetation
can be destroyed without destroying fertility, which is what makes regrowth a
recovery mechanic rather than a permanent loss.

---

## 4. Simulation

### 4.1 Tick model

- Fixed **30 Hz** simulation tick. No variable timestep, ever.
- Fixed-point **Q16.16** for walker positions and mana accumulators. Grid fields are
  plain integers in the units of §3.6.
- No wall-clock time inside the simulation. Tick count is the only clock.
- Render interpolates between the last two sim states; it never advances state.

**Frame budget:** 33.3 ms per frame at 30 Hz. Split `[START]`: **12 ms simulation,
21 ms render and everything else.** If simulation exceeds 12 ms, reduce `N` — never
reduce the tick rate, which would change game feel and invalidate all tuning.

Tick pass order is fixed and load-bearing for determinism:

```
1. ghost border copy            (24 ops)
2. command application          (this tick's input)
3. water transfer               (checkerboard: even, then odd)
4. lava transfer                (checkerboard: even, then odd)
5. material interactions        (single pass, §4.4)
6. granular movement            (checkerboard: even, then odd)
7. vegetation growth            (single pass)
8. walkers: movement            (fixed walker-id order)
9. walkers: combat resolution   (§4.7)
10. settlements: build / decay
11. every 15 ticks: flow field + influence projection (§4.5)
12. mana accrual
13. every 30 ticks: state hash
```

### 4.2 Terrain deformation

The core free verb is raise/lower land in discrete terrace steps within a brush
footprint. Terrain change is the *only* mechanism that alters the pathfinding graph.

Terrain smoothness is the central strategic axis: rolling terrain yields small
settlements that spread fast but are weak; flat terrain yields large fortified
settlements that grow slowly and produce strong walkers (§4.6). This emerges from
one verb — do not add a tech tree or building menu to reproduce it.

**Material conservation** (pillar 4): lowering a cell yields matter into a
player-held budget; raising consumes from it. Expose the budget diegetically — the
amount of matter visibly held in the hand — not as a number.

**The hand carries three materials.** From From Dust: the hand is a pipette, not
only a shovel.

```rust
struct Hand { material: Material, amount: u16 }   // earth | water | lava
```

Capacity `[START]` 4096 units per material. Mixing is impossible — picking up a
second material requires depositing the first. This unlocks at no systemic cost:

- carry water → irrigate dry soil, drain a channel
- carry water onto lava → make rock at a chosen location (§4.4)
- carry lava → an attack that is simultaneously land reclamation

### 4.3 Water

**Not a fluid simulation.** Water is a per-cell integer depth. Checkerboard two-pass
so the result is scan-order independent while staying deterministic.

Per neighbour pair `(a, b)`, evaluated once per pass:

```rust
let sa = height[a] as i32 + water[a] as i32;
let sb = height[b] as i32 + water[b] as i32;
if sa <= sb { return; }
let mut flow = (sa - sb) / 4;                  // /4, not /2: four neighbours per cell,
                                               // /2 overshoots and oscillates
flow = flow.min(water[a] as i32);              // cannot move more than exists
let drag = 256 - vegetation[a] as i32;         // [START] linear vegetation damping
flow = (flow * drag) / 256;
if flow == 0 { return; }
water[a] -= flow as i16;
water[b] += flow as i16;
if flow > EROSION_FLOW_MIN { mark_eroding(a); } // feeds §4.4
```

Global sea level is a single integer, raised by the flood power and by the tide
cycle (§5.5). Cells below sea level are filled to it.

**Vegetation dampens transfer.** One term, and it makes forests mechanically
load-bearing rather than decorative. This is physically grounded — coastal forests
dissipate wave energy through reflection and dissipation, block debris and stabilise
soil against scouring — and it produces one specific emergent behaviour worth
designing around:

> An open gap in a forest — a road, a river, an elevation change — channels and
> amplifies a strong current by forcing it into the gap.

That falls out of the damping term for free, and it is the cleanest expression of
pillar 3 in the design: an opponent cuts a notch in your coastal treeline, has
destroyed nothing but plants, and the next tide focuses through the gap and hits
three times harder. **Do not special-case this.** Verify it emerges (Phase 4 DoD);
if it does not, the damping term is wrong.

### 4.4 Materials

The heart of the simulation, and the main thing taken from From Dust. Not a physics
model — a **per-cell integer state machine**, cheap and bit-reproducible.

**Granular movement.** Sand and ash move to a lower neighbour when the height
difference exceeds an angle-of-repose threshold. Rock and soil do not move.

**Interaction matrix.** All constants `[START]`, in the units of §3.6.

| Condition | Result |
|---|---|
| eroding flow (`> 32`) over `sand` | `height -= 2`, `sediment += 2` |
| eroding flow over `ash` | `height -= 3`, `sediment += 3` |
| eroding flow over `rock` | no effect — rock is the erosion-proof material |
| `lava > 0` adjacent to or under `water >= 16` | lava → `rock`, `height += lava`, `water -= 48` |
| `lava > 0` on `vegetation > 0` | `vegetation = 0`, `fertility -= 64` (floor 0) |
| `lava > 0` on `sand` | `material = rock` |
| `sediment >= 128` on `rock` or `sand` | `material = soil`, `fertility += 32`, `sediment -= 128` |
| `water` in `1..=48` on `soil`, `fertility > 0` | `vegetation += 1` every 8 ticks, capped at `fertility` |
| `vegetation == 0` and `water == 0` for 600 ticks | `fertility -= 1` every 60 ticks; at 0, `material = sand` |

Angle of repose `[START]`: sand 24 units, ash 16 units.

**Lava is a construction verb, not a destruction verb.** Because it cools to rock on
water contact, it is the only way to create permanent new land — and with sea level
cycling (§5.5), creating land is the counter-play to losing it. Consequences:

- The volcano is not a weapon. It is **the most contested resource on the planet**;
  both gods need the same crater. Do not balance it as damage.
- Contesting it is done by shaping channels, never by attacking. Pillar 3 holds.

**Nature repairs itself** — required by §4.6 and pillar 5. Tides wash sediment back
onto shores, erosion smooths slopes, vegetation regrows from surviving fertility.
Terrain damage must never be permanent, or a lost early wave decides the match.

**Render-side only:** splashes, foam, spray, steam plumes at lava/water contact,
embers, erosion particles. Driven by a separate render PRNG that never touches
simulation state.

### 4.5 Flow field, influence and walkers

**Flow field.** Integer-cost BFS from targets (papal magnet, settlements) over
passable cells, producing a per-cell direction field. Neighbour iteration order is
fixed: N, E, S, W — never derived from a hash or a set.

**Recompute on a fixed tick boundary — every 15 ticks (0.5 s) — never immediately on
terrain change.** Immediate recompute would couple the result to event ordering.

**Influence projection.** This closes a real hole: `influence` is read by mana
accrual but previously had no write rule.

Influence is **projected from settlements over the BFS graph**, on the same 15-tick
boundary as the flow field. Each settlement emits a strength equal to its tier
strength (§4.6), decaying by integer distance:

```rust
// per settlement, BFS outward, stop when contribution reaches 0
contribution = tier_strength * INFLUENCE_REACH - bfs_distance
// [START] INFLUENCE_REACH = 6 cells per strength point
influence[cell] = clamp(sum_a - sum_b, -127, 127)   // a and b are the two gods
```

Cells outside every settlement's reach stay 0 and count for nobody.

Rejected alternative: "whoever last reshaped the cell owns it." That would make mana
a function of clicking — a player would tap cells to generate income without
settling them.

The important property: **influence is zero-sum.** A cell belongs to one god or the
other, and the total is bounded by habitable land, which the tides keep finite.
Gaining influence necessarily means taking it. This is what preserves the
anti-snowball property of §4.6 even though mana is now settlement-derived.

**Walkers.** Store `(face, x: Q16.16, y: Q16.16, strength: u8, hp: i16)` and follow
the flow-field gradient. Crossing a seam applies the §3.3 transform.

Behaviour with no magnet placed: **seek the largest buildable plateau inside own
influence, and never leave own influence.** The papal magnet is the *only* way to
expand beyond it — which reinforces pillar 1: the magnet is the single command in
the game, and it is what makes expansion and aggression a deliberate act.

**Walker animation is purely cosmetic and must never feed back into simulation
state.** No IK, no ragdoll, no physics-driven foot placement in the sim. The sim
moves a point; the renderer animates a figure around it.

Walker cap `[START]` 512 per player. `[MEASURE]` against the 12 ms budget.

### 4.6 Settlements and mana

**Build sites are contiguous plateaus of exactly equal height.** This makes
"flatten" a sharp verb with a sharp reward, and wide-vs-tall falls out
automatically. All values `[START]`:

| Plateau | Tier | Population | Tier strength |
|---|---|---|---|
| 3×3 | hut | 2 | 1 |
| 5×5 | house | 5 | 2 |
| 7×7 | fortress | 10 | 4 |
| 9×9 | citadel | 18 | 7 |

Tier strength drives three things at once: walker strength (§4.7), influence reach
(§4.5), and mana multiplier. One number, three consequences — deliberate.

**Mana accrues from held habitable territory, not from raw population count.** This
is the deliberate divergence from Populous and the primary snowball fix.

A cell contributes if it is above current sea level, has `material` of soil or rock,
and `influence` favours that player. Settlement tier acts as a multiplier on the
cells within its reach, not as the base.

```
mana_per_tick = sum(contributing cells) * tier_multiplier / MANA_DIVISOR
// [START] MANA_DIVISOR = 256
```

Why this matters: population is self-reinforcing — more people, more houses, more
people, nothing pulling back. Direct conflict *amplifies* that loop, because
conquest adds population. Habitable territory is bounded and the sea keeps taking it
back, so the mode's core mechanic continuously erodes the leader's advantage.

Population still matters — it builds, it fights, it can be lost, and it is what the
magnet steers — but it is no longer the power source.

Additional mitigations:

- Divine interventions cost far more mana than terraforming.
- The strongest board-wide power (flood) damages both players symmetrically.
- Per-wave scoring rather than cumulative (§5.5), so one lost wave is not the match.
- Nature self-repairs (§4.4).

This is the load-bearing part of failure mode 2 (§13). Treat it as a pillar, not a
tuning knob.

### 4.7 Combat

Walkers fight autonomously on contact. The player never issues an attack order
(pillar 3); the player decides where the magnet is and what the terrain allows.

**Netcode note:** autonomous combat is simulation, not player input. It requires no
frame-accurate response, so the pillar-2 latency argument is unaffected.

**Walker combat.** All values `[START]`:

```
walker.strength = spawning settlement tier_strength
walker.hp       = strength * 16
```

Two hostile walkers in the same cell each lose the opponent's `strength` in hp per
tick. At `hp <= 0` the walker is removed. The stronger survives with a remainder, so
attrition is meaningful and stacking matters. No randomness; if any is wanted later
it must come from the seeded sim PRNG only.

**Resolution order is the determinism trap.** Specified exactly:

1. Iterate cells in fixed flat-index order (face, then y, then x).
2. Within a cell, sort participating walkers by walker ID ascending.
3. Resolve pairwise in that order.

Never iterate a collision structure's natural order. Never sort without ID as final
tiebreaker. This is a hard rule and belongs in §10.

**Settlements fall gradually, never instantly.** Enemy walkers inside a settlement
footprint reduce its build progress by `1 * strength` per tick; when progress drops
below the current tier's threshold, the tier drops, and at hut level the settlement
is razed.

Gradual decay is required, not cosmetic: it creates the reaction window in which the
god can intervene with terrain — swamp the approach, reroute water, cut the path,
raise a wall. Instant destruction would hollow out pillar 3, because there would be
nothing to respond to.

**Champion.** The leader becomes an autonomous warrior who seeks enemy settlements
and razes them until killed. The magnet transfers to the champion, so the player has
no leader until a walker touches the magnet again. Any number can be created while
mana allows.

The champion is no longer an outlier against pillar 3 — with combat in the game it
is simply the escalation lever. Open decision resolved: **keep it.**

---

## 5. Verbs

### 5.1 Always available

Following the Populous II correction — never strip the core verbs.

| Verb | Cost | Notes |
|---|---|---|
| Raise / lower land | free | Where ~90% of playtime goes. Direct drag, no menu entry. |
| Papal magnet | cheap | Place a flag; population walks toward it. The *only* command in the game. First walker to reach it becomes leader; if the leader dies the magnet drops there. |
| Armageddon | very expensive | Immediately triggers the final tide wave at maximum strength. Stalemate breaker. Deliberately awkward to invoke (§8). |

### 5.2 Map-gated powers

Availability and parameters are declared per map (§5.4).

- **Earthquake** — lowers and dents terrain. Nominally a weapon, in practice the
  repair tool for volcano damage. Essential on maps where raise/lower is disabled.
- **Swamp** — created on flat ground; swallows walkers that enter. Map option:
  bottomless (persists; removable only by burying via raise or excavating via lower)
  vs. consumed after one victim.
- **Volcano** — opens a lava vent. Its real function is generative (§4.4). Do not
  balance it as damage.
- **Flood** — raises global sea level one step. **Damages both players.**
- **Champion** — see §4.7.

### 5.3 Modifiers (from Black & White)

Multiply the verb set without adding verbs:

- **Thrown vs. poured** — thrown: large radius at the impact point. Poured: same
  effect, small radius directly under the hand.
- **Increased / extreme variants** — same verb scaled, at proportionally higher
  cost, selected with a held modifier key (shift / alt / ctrl, §8).
- **One-shot pickups** — free single-use powers lying on the terrain. Contested map
  objects; excellent in a duel.

### 5.4 Map manifest

The map is the ruleset, not just geometry. This is how Bullfrog got 500 worlds out of
eight powers, and it is the cheapest source of variety here. Pure configuration, no
runtime state, therefore trivially deterministic.

```toml
[world]
n = 64
seed = 0x5EED
terrain = "archipelago"

[mode]
kind = "conquest"
waves = 3                    # user decision; the [START] was 7
score = "per_wave"

[mode.tide]
telegraph_ticks = 900        # 30 s visible warning
impact_ticks    = 600        # 20 s surge and recede
recovery_ticks  = 25500      # 14:10 calm — a wave every 15 minutes
lull_ticks      = 2700       # 90 s before the first wave and after the last
escalation      = 150        # percent per wave, integer

[powers.earthquake]
enabled = true
cost = 120

[powers.swamp]
enabled = false              # deliberately withheld, as in later Populous worlds

[powers.raise_lower]
enabled = true               # false makes earthquake the only build tool
```

### 5.5 Mode: conquest

**A normal 1v1 conquest mode. The tides are a world property, not the mode.** The
peoples decide the match; nature sets the terms (pillar 5).

The tide cycle runs throughout:

1. **Telegraph** — the wave is visibly building; the player can see where it will
   land and has time to act.
2. **Impact** — sea level surges, water floods inland, vegetation and settlements
   below the line are lost.
3. **Recovery** — a calm window to rebuild, replant, re-channel, and reclaim land
   with lava.
4. Repeat, escalating.

This does three jobs, none of which is "be the boss":

- keeps habitable land finite, so influence stays zero-sum (§4.5)
- periodically erases fortifications, so entrenchment is never permanent
- **compresses the habitable band, pushing the two peoples toward each other until
  contact is unavoidable**

The third is the important one. Without it both players could build in their own
corner and the war would be optional.

Each wave is naturally a scoring round, which is where per-wave scoring (§4.6) gets
its anchor. Escalation provides the match clock without a countdown UI.

**Victory** — all `[START]`:

- 3 waves, **fifteen minutes apart** (user decision, superseding the `[START]` of
  7 waves 45 seconds apart, which put a whole match inside six minutes). Score
  per wave = habitable cells under own influence, sampled at wave peak. Most
  waves won takes the match.
- The opening and closing calm are `lull_ticks`, not `recovery_ticks`: at this
  cadence a recovery is fourteen minutes, and running the two ends on it would
  put fourteen minutes of nothing before the first telegraph and another
  fourteen after the last wave had already decided the match.
- Sudden death: influence reaching 0 is an immediate loss, whatever the score.
- Target match length ~34 minutes: three waves at the cadence plus the two lulls.
- **Known consequence, unmeasured against a human.** The scripted opponent is
  tick-paced and beats a player who never acts by siege at around tick 3,400,
  while the first wave now lands at 3,900 — so an idle match against the AI ends
  before any wave. Against a player who plays, and against another human, the
  wave clock is the match clock as §5.5 intends. Phase 8 playtesting.

**There is no starting land connection, on any profile** (user decision). The
carved contact corridor is gone: a ridge running half the planet's circumference
between the two spawns, laid across whatever geology happened to be under it, was
the most artificial thing in the world. Two peoples on separate islands is a
legal opening, both sides reclaim toward each other, and every causeway you build
also serves your opponent — which is what the archipelago mode below was for and
is now simply how the game starts. See `docs/specs/world.md` and
`MapConfig::land_bridge`, which keeps the corridor available to the §6.3 corpus
and nowhere else.

Later modes: **volcano** (central crater erupts in waves; lava follows whatever
channels currently exist, so channel-shaping *is* the fight).

---

## 6. Multiplayer and netcode

### 6.1 Model

Deterministic lockstep. Only inputs cross the wire; all state is derived. Bandwidth
is independent of world size, destructibility and walker count.

### 6.2 Command frames

```
tick: u32        // target tick, not send tick
player: u8
verb: u8
face: u8
x: u16
y: u16
modifier: u8     // thrown/poured, increased/extreme
```

Packed to 8 bytes. Every tick both clients exchange a frame, empty frames included,
so a silent peer is distinguishable from a stalled one.

**Input delay: 6 ticks (200 ms)** `[START]`. Generous by action-game standards and
invisible in this genre — spend the latency budget here rather than risking stalls.

Verb selection (the radial power menu, §8) runs entirely client-side; only the
result `(verb, modifier, target cell)` enters the command stream. That invariant
predates the menu — it held for the retired gesture recogniser too — and it is
what keeps the input surface swappable without touching the wire format.

### 6.3 Desync detection

- Hash `height`, `water`, `lava`, `material`, `influence` plus walker and settlement
  state every 30 ticks. FNV-1a or xxhash. The terrain arrays are extremely sensitive
  to divergence, which makes them a near-ideal checksum.
- On mismatch: halt immediately, dump both states plus the input log. Do not attempt
  to resync.
- CI acceptance criterion `[START]`: 10 recorded matches of ≥ 20,000 ticks each,
  covering every verb at least 20 times and at least 200 combat resolutions, replay
  bit-identical native vs. headless browser. Any mismatch fails the build.

### 6.4 Keyframes

Snapshot every 300 ticks (10 s) for reconnect and spectating: RLE or delta compressed
field arrays plus walker and settlement state. Without this a late joiner would have
to replay the entire input history.

Caps `[START]`: max 64 KB per keyframe compressed, max 90 retained (15 minutes). A
keyframe exceeding the cap is a bug in the compression, not a reason to raise the
cap.

### 6.5 Transport

- WebRTC DataChannel, **`iceTransportPolicy: "relay"`** — TURN only, so peer IPs are
  never exposed.
- Cloudflare Realtime for TURN. Endpoints: UDP `turn.cloudflare.com:3478` (alt 53),
  TCP 3478/80, TLS 5349/443.
- Durable Objects: Lobby (signalling, match setup), Directory, Budget Gatekeeper.
- Static assets on Cloudflare Pages: unlimited bandwidth, does not touch any of the
  budgets below.

### 6.6 Cloudflare Free Tier budget

Current Free Tier limits, verified rather than assumed:

| Resource | Free limit |
|---|---|
| Workers requests | 100,000 / day |
| Workers CPU | 10 ms / request |
| Durable Objects requests | 100,000 / day |
| **Durable Objects duration** | **13,000 GB-s / day** |
| DO SQL storage | 5 GB (SQLite backend only on Free) |
| Realtime TURN egress | 1,000 GB / month, then $0.05/GB |
| Cloudflare Pages bandwidth | unlimited |

Durable Objects are available on the Workers Free plan with the **SQLite storage
backend only** — the key-value backend is not. Use SQLite.

The TURN free tier is **shared between TURN and SFU**, not two independent
allowances. Do not add an SFU (e.g. for voice chat) without recomputing.

**Per-match traffic.** A command frame is 8 bytes, but SCTP + DTLS + UDP + IP +
TURN ChannelData overhead brings a packet to roughly 100 bytes. At 30 Hz that is
3 KB/s per direction. TURN bills only Cloudflare→client egress, and both directions
are relayed, so a match costs about **6 KB/s**, or ~5.4 MB for a 15-minute match.

Against 1,000 GB/month that is roughly **185,000 matches per month**. TURN is not a
constraint and should not be treated as one.

**Note the efficiency, though:** 8 bytes of payload inside a ~100 byte packet is 8%.
Overhead dominates completely. `[START]` **batch 2 ticks per packet** — halves traffic
for 66 ms of added delay, comfortably inside the 200 ms input-delay budget of §6.2.

**The binding constraint is Durable Object duration, not requests and not
bandwidth.** 13,000 GB-s/day at 128 MB per object is roughly **28 DO-hours per day**.
A Lobby DO held open for a whole 15-minute match consumes 0.25 DO-hours, which caps
the platform at about **112 matches per day** — ten times tighter than DO requests
and fifty times tighter than TURN.

**Architectural rule, not a quota to monitor: the Lobby DO must not stay alive during
a match.** With pure P2P lockstep it has nothing to do once the connection is
established. Signal, then exit. Where a connection genuinely must persist (reconnect,
spectator), use the **WebSocket Hibernation API** — a hibernated DO accrues no
duration.

With that rule the binding constraint returns to DO requests: at roughly 30 requests
per match, about **3,300 matches/day**. Ample.

The Budget Gatekeeper DO enforces these ceilings; reuse the design from
amigo-metropolis rather than re-deriving it.

**Recorded trade-off:** STUN at `stun.cloudflare.com` is free and unlimited, but
`iceTransportPolicy: "relay"` excludes it by design. TURN bandwidth is being spent
deliberately to buy IP privacy. The maths above shows the cost is negligible, but it
is a choice, not a technical necessity — do not silently relax it to "save
bandwidth".

**Hard rule:** no per-tick server traffic, ever. All gameplay traffic is peer-to-peer
over TURN. The moment a tick touches a Worker or DO, every budget above breaks.

---

## 7. Rendering

### 7.1 Sim grid is not the render mesh

The simulation is discrete integer. The mesh is a **smoothed interpolation** of the
height field, chunked per face (`[START]` 16×16 cells per chunk), with only dirty
chunks re-meshed. Without smoothing the result is Minecraft terracing, not Black &
White 2.

Smoothing method, specified so it is not improvised:

1. Build on the **dual grid**: vertex height = mean of the 4 surrounding cell
   heights. Puts vertices at cell corners and halves the terracing immediately.
2. One **Laplacian pass, material-weighted** `[START]`: rock 0.15, soil 0.40,
   sand 0.60, ash 0.55. Rock stays crisp and cliff-like; sand reads as dunes. The
   material map thereby drives silhouette, not just colour.
3. **Chunk skirts** — extend each chunk one cell beyond its border and drop the edge
   vertices downward, to hide seams between chunks at different update times.
4. **Seam vertices come from ghost-border data**, so face boundaries are continuous
   with no special case.

Meshing runs in Rust and writes vertex/normal/attribute buffers directly into WASM
memory; TypeScript wraps them in `THREE.BufferAttribute` views and only sets
`needsUpdate`.

### 7.2 Camera

Orbit on a spherical shell; panning rotates the planet. No map edges, no camera
constraints to fight.

**Keep the planet small enough that the horizon against space is always visible.**
The curvature is the visual identity — a planet large enough to look flat wastes the
entire architecture.

The sun has its own slow day cycle rather than being fixed in space, plus a soft
camera-anchored fill light so the night side stays readable.

### 7.3 Effect tiers

Gate behind a quality setting so it runs on weak hardware.

**Tier 1 — always on**
- Atmosphere: second slightly larger sphere, transparent, Fresnel rim glow. ~20
  lines of shader, one draw call, highest impact per line in the whole list.
- Water depth absorption (Beer–Lambert): shallow teal → deep blue, exponential.
- Wet-sand band at the waterline: darken albedo by distance to current water height.
  Costs nothing, and since water level is the core mechanic this band visibly
  migrates during play.
- Slope- and height-based texturing: steep → rock, flat → grass, high → snow, from
  normal and altitude. Avoids UV-mapping a quadsphere entirely.
- FXAA. Not optional — instanced trees on a sphere alias badly.
- Rim light on walkers. Functional: tiny figures must separate from any terrain.
- ACES tone mapping, subtle bloom.

**Tier 2 — medium**
- Cloud shell: scrolling noise sphere; sample the same noise in the terrain shader
  for ground shadows.
- Night side with emissive settlement lights. Doubles as readability — population
  distribution at a glance.
- Instanced vegetation, density from the `vegetation` field.
- Single sun shadow map (the planet is small; cascades unnecessary).
- Screen-space water refraction plus two normal maps scrolling at different speeds
  and directions.
- Sun glitter: high-exponent specular on the ocean.

**Tier 3 — high**
- SSAO (prefer N8AO over `SSAOPass`). Most of the diorama feel comes from contact
  shadows.
- Subtle depth of field at the planet limb.
- God rays as radial blur when the sun is on screen.
- Hand light cone plus radial falloff showing influence reach — diegetic, replacing
  a UI radius indicator.

Draw-call ceiling `[START]` 150 at tier 2. `[MEASURE]`.

### 7.4 Terrain that remembers

The simulation already carries `fertility`, `vegetation`, `sediment`, `material` and
`influence`. Write them as vertex attributes and let the shader blend colour from
them. A valley that was flooded stays darker and greener; where lava ran, rock
remains; long-settled land reads as cultivated. Visual richness falls out of
simulation data rather than authored art.

`influence` blends between two colour moods — including vegetation species and water
tint — one per god. The boundary between the zones is the most visually interesting
region of the planet, which is also where the war happens.

### 7.5 Assets, licensing and budget

Everything above is procedural: shaders plus simulation data. No purchased textures,
no third-party models, no licensing exposure. MIT-clean and near-zero repo weight.
Keep it that way — if an asset is needed, CC0 only.

Budget `[START]`: ≤ 3 MB initial payload compressed, ≤ 4 s to interactive on the
target device, meshopt + KTX2 for anything that is not procedural.

### 7.6 Target hardware

**Desktop browser only. Mobile and tablet are out of scope.**

Reference floor `[START]`: a desktop PC with **integrated graphics of roughly Intel
UHD 630 / Iris Xe class, 4 cores, WebGL2**. An ordinary office machine with no
discrete GPU.

**The development workstation is explicitly not the reference.** Every `[MEASURE]`
value — `N`, walker cap, draw-call ceiling, the 12 ms simulation budget — must be
verified against the reference floor, not against the machine the code is written on.
On a strong GPU the budgets are never observed to be violated, which is precisely the
failure mode.

Practical consequence: run the Phase 1 perf harness and the Phase 2 frame-rate DoD
with GPU throttling or on a second, deliberately weak machine. Record the measured
numbers in this document, replacing the `[START]` values.

---

## 8. Input: the hand

- **No persistent HUD.** The god has no body, only a hand — cursor, matter
  carrier and influence indicator in one. The one exception is the *transient*
  radial power menu below, which exists only between its opening right-click
  and its close. (This narrows the original "no HUD" pillar: the gesture
  alphabet it described was retired by user decision in favour of a menu.)
- Mana, held matter and influence reach are all communicated diegetically.

**Controls.** The right button carries both camera and casting: a drag orbits,
a click (under 5 px of travel, under 400 ms — the same test the left button
uses for the magnet) opens the radial power menu at the cursor.

| Input | Verb |
|---|---|
| direct drag (left) | raise / lower land |
| click (left) | place papal magnet |
| drag (right) | orbit the planet |
| click (right) | open the power menu |
| menu slice | magnet · earthquake · (swamp) · volcano · flood · champion · armageddon |
| shift / alt / ctrl | thrown / increased / extreme variant |

The menu snapshots the cell under the cursor when it opens and casts there;
flood, champion and armageddon ignore the target in the sim anyway. Slices
show their manifest cost (from `dio_power_cost`/`dio_power_enabled`, never a
mirrored table), grey out live when unaffordable, and show collected free-use
charges. Raise/lower deliberately has no menu entry — it is the constant verb
and must stay a frictionless drag. Armageddon deliberately keeps the most
friction; it is irreversible, so its slice demands a second, confirming click
within 1.5 s in place of the old two-second hold.

---

## 9. Architecture

### 9.1 Language split

**Rust → WASM:** height field, water, lava, material matrix, granular movement, seam
table and ghost borders, flow field, influence projection, walkers, combat,
settlements, mana, command application, tick loop, state hash, chunk meshing.

**TypeScript:** Three.js, camera, the radial power menu, WebRTC, lobby and
Durable Objects, audio, shell UI.

### 9.2 Why Rust for the simulation

1. **Fixed-point is trivial in Rust, manual in JS.** Q16.16 multiply needs a 64-bit
   intermediate: `((a as i64 * b as i64) >> 16) as i32`. JS has no i64; `Math.imul`
   gives only the low 32 bits. WASM integer arithmetic is bit-exact across engines
   *by specification*.
2. **You own the entire math stack.** `Math.sin` in JS is implementation-defined and
   differs in the low bits between V8, JSC and SpiderMonkey — a time bomb for
   lockstep. In WASM, float ops are IEEE754-deterministic by spec and transcendental
   functions are compiled-in libm, i.e. *your* code. Both clients load the same
   `.wasm`, so they compute identically. Consequence: keep the grid in integers, but
   camera and helper math may use `f32` freely.
3. **A native replay verifier from the same source.** The same crate compiles to
   WASM for the browser and to a binary for CLI. Replay an input log natively,
   compare per-tick hashes, pin a desync to an exact tick. For lockstep debugging
   this is the difference between an hour and a week.

### 9.3 WASM boundary

Zero-copy. Rust owns state in linear memory; JS holds only views:

```ts
const heights = new Int16Array(memory.buffer, world.heights_ptr(), 6 * S * S);
```

Per tick: write a few bytes of commands, call `world.tick()`, renderer reads from the
views. **One call per tick, not one per entity.**

Pitfall: growing WASM memory detaches all views. Pre-allocate and never grow, or
recreate every view after growth.

### 9.4 Toolchain

The interface is a handful of functions plus a memory pointer, so `wasm-bindgen` is
unnecessary:

```
cargo build --release --target wasm32-unknown-unknown
wasm-opt -Oz --enable-bulk-memory
```

Use `#[no_mangle] pub extern "C"` and `WebAssembly.instantiateStreaming`. No glue JS,
smaller binary, full control — consistent with amigo-native.

Frontend: Bun, Vite, TypeScript strict with `noUncheckedIndexedAccess` and
`verbatimModuleSyntax`, Biome (2-space, 100 char, double quotes, semicolons, trailing
commas). React only for shell UI (lobby, menus); the game canvas lives outside React.
Conventional Commits.

The simulation crate must be `no_std`-compatible: no allocation inside a tick.

---

## 10. Determinism rules

Rust does not give determinism for free. A violation is a bug even if no desync has
been observed.

- **No `HashMap` or `HashSet` in simulation code.** `RandomState` seeds randomly per
  process, so iteration order is not reproducible. Use `BTreeMap` or index arrays.
- **No sort without a total order.** Always append entity ID as the final tiebreaker.
- **Combat resolution follows §4.7 exactly:** cells in flat-index order, walkers
  within a cell sorted by ID ascending. Never a collision structure's natural order.
  This is the highest-risk site in the codebase.
- **Explicit overflow semantics.** Release builds wrap silently, debug builds panic.
  Write `wrapping_add` / `saturating_*` so both profiles agree.
- **No floats in simulation state.** `f32`/`f64` in render code only.
- **No GPU compute in the simulation.** GPU floating point varies across vendors,
  drivers and browsers; two clients diverge within seconds. The GPU renders, never
  simulates. This is the single most likely way to break the project.
- **One seeded PRNG for the sim**, advanced only on tick boundaries, never from the
  render loop or from input. A separate, unconstrained render PRNG handles particles
  and foam.
- **Fixed neighbour iteration order** everywhere (N, E, S, W).
- **Fixed tick pass order** as listed in §4.1.
- **Animation never feeds back into state.**
- **No wall-clock time in the simulation.**
- **Flow field and influence recompute only on fixed tick boundaries.**

Enforce with a `#![deny]` lint set plus the CI replay test of §6.3.

---

## 11. Open items

**Resolved:** project name, totems (rejected), mana source (held territory), combat
(kept, autonomous, §4.7), champion (kept), pillar 3 wording, `influence` write rule,
tides (pressure not opponent), target hardware (desktop browser only, §7.6),
Cloudflare budgets (§6.6). No blocking inputs remain.

**Still open, non-blocking:**

3. Whether `influence` stays authoritative state or becomes a pure derivation of
   settlements each recompute. Currently authoritative; derivation would shrink the
   keyframe but add a full recompute cost on load.
4. Whether mana-level unlock ladders are needed at all, now that mana is
   territory-derived. Possible simplification: all map-enabled powers available from
   the start, gated only by cost. Fewer systems, and it removes the "smaller
   vocabulary when behind" compounding effect. **Leaning toward cost-only.**
5. Wave escalation curve shape — linear percent per wave is the `[START]`; a
   step function might read better.
6. Whether combat should use the seeded PRNG at all. Currently fully deterministic
   attrition with no randomness; playtest whether that feels too mechanical.

---

## 12. Plan

Sequential. Do not start a phase before the previous one meets its Definition of
Done. Atomic commits, Conventional Commits, one branch per phase.

Effort estimates are `[START]` and assume side-project evenings, not full days.

### Phase 0 — skeleton · ~1 evening

- [ ] Init repo, Bun workspace, Rust crate, Biome and TS config per §9.4
- [ ] Split this document into `docs/specs/{world,simulation,combat,verbs,netcode,rendering,determinism}.md`
- [ ] `PLAN.md` with the tasks below
- [ ] CI: `cargo test`, `cargo clippy`, `biome check`, `tsc --noEmit`
- [ ] Determinism lint set (`#![deny]`) in the sim crate

**DoD:** CI green on an empty commit. `cargo run` prints a version string.

### Phase 1 — world crate · ~3 evenings

- [ ] Face indexing, stride, ghost border layout (§3.2), units (§3.6)
- [ ] 24-entry seam table (§3.3)
- [ ] Ghost border copy, 24 ops per tick
- [ ] Raise/lower land with material conservation
- [ ] State hash
- [ ] Native CLI target that ticks a world and prints per-tick hashes
- [ ] Perf harness reporting ms per tick per pass

**DoD:** closed-loop property test passes for all 24 seam entry points. Two native
runs of 10,000 ticks from the same seed produce identical hash sequences. Perf
harness reports a per-pass ms breakdown. `N` chosen against the 12 ms budget and
recorded in the spec with the measured number.

### Phase 2 — renderer · ~4 evenings

- [ ] Tangent-adjusted cube-to-sphere projection
- [ ] Dual-grid + Laplacian smoothing per §7.1, material-weighted
- [ ] Chunked mesh generation in Rust, dirty-chunk re-mesh, skirts
- [ ] Zero-copy `BufferAttribute` views (§9.3)
- [ ] Orbit camera on spherical shell, pan rotates planet
- [ ] Tier 1 effects (§7.3)
- [ ] **Research task:** Populous 1/2 balance numbers into
      `docs/balance-research.md` from the sources in §2. Do not invent values;
      mark gaps `TODO`.

**DoD:** raise/lower is visible and immediate. No terracing artefacts, no chunk
seams, no face-boundary cracks. Horizon against space visible at all camera
positions. 30 fps sustained at tier 1 on the target device.

### Phase 3 — population · ~4 evenings

- [ ] Flow field, fixed neighbour order, 15-tick boundary
- [ ] Influence projection (§4.5) on the same boundary
- [ ] Walkers with seam crossing
- [ ] Plateau detection and settlement tiers (§4.6)
- [ ] Mana accrual from held territory
- [ ] Papal magnet and leader mechanics
- [ ] Walker behaviour with no magnet placed

**DoD:** flattening a 5×5 plateau reliably produces a house. Walkers stay inside
influence without a magnet and expand only with one. Mana rises with held territory
and falls when territory is lost. 512 walkers inside the 12 ms budget, or the cap
revised with the measured number.

### Phase 4 — materials · ~5 evenings

- [ ] Water transfer per the §4.3 formula, checkerboard
- [ ] Global sea level
- [ ] Lava transfer, checkerboard
- [ ] Full material matrix (§4.4), **table-driven, not hardcoded branches**
- [ ] Granular movement with angle of repose
- [ ] `sediment`, `fertility`, `vegetation` updates
- [ ] Vegetation damping term in water transfer
- [ ] Hand carries three materials (§4.2)
- [ ] Nature self-repair loop
- [ ] Render-side particles and steam plumes on the separate PRNG
- [ ] Tier 2 water effects

**DoD:** water settles to a stable level with no oscillation over 5,000 idle ticks.
Lava meeting water reliably yields rock. **The forest-gap channeling behaviour of
§4.3 is observed without any special-case code** — if it is not, the damping term is
wrong and must be fixed, not worked around. Determinism hashes still match across
10,000 ticks with all material passes active.

### Phase 5 — combat · ~3 evenings

- [ ] Walker strength from settlement tier
- [ ] Contact attrition per §4.7
- [ ] Resolution ordering exactly per §4.7 and §10
- [ ] Gradual settlement decay with reaction window
- [ ] Champion

**DoD:** a stress scenario with 200 simultaneous contacts replays bit-identically
across 100 runs from the same seed, and identically native vs. browser. A settlement
under attack takes long enough to fall that a terrain response can save it — verify
by actually saving one.

### Phase 6 — verbs · ~4 evenings

- [ ] Map manifest parser (§5.4)
- [ ] Per-use costs; unlock ladder only if open item 4 keeps it
- [ ] Earthquake, swamp, volcano, flood
- [ ] Thrown vs. poured, increased/extreme
- [ ] One-shot pickups
- [ ] Gesture recognition on a fixed timer, set per §8 *(superseded: the
      gesture alphabet was retired for the radial power menu — see §8)*
- [ ] Armageddon
- [ ] Hand interface, no HUD

**DoD:** every power castable from the §8 radial menu, at 15 fps as reliably as
at 60 fps. Disabling a power in the manifest removes it from the menu and the
game with no code change. No persistent HUD element anywhere on screen.
*(Original wording asked for gesture recognition; superseded as above.)*

### Phase 7 — netcode · ~5 evenings

- [ ] Command frame encoding, 8 bytes (§6.2)
- [ ] Lockstep loop, 6-tick input delay, 2 ticks batched per packet (§6.6)
- [ ] WebRTC DataChannel, `iceTransportPolicy: "relay"`
- [ ] Lobby Durable Object, signalling, Budget Gatekeeper — **SQLite backend, and the
      DO must exit or hibernate once the match starts** (§6.6)
- [ ] Hash exchange every 30 ticks, halt on mismatch
- [ ] CI replay test to the §6.3 acceptance criterion

**DoD:** the §6.3 criterion passes. A full match played over a relayed connection
with simulated 120 ms RTT and 2% packet loss completes without desync, and the input
delay is not noticeable to the player. **Measured DO duration for a full match is
under 5 GB-s** — if it scales with match length, the DO is still alive and the
architectural rule in §6.6 is violated.

### Phase 8 — conquest mode · ~3 evenings

- [ ] Tide cycle: telegraph, impact, recovery, escalation (§5.5)
- [ ] Telegraphing readable without UI
- [ ] Per-wave scoring
- [ ] Victory and sudden death
- [ ] Two-god palette blend from `influence`

**DoD:** a full 7-wave match completes in roughly the target 15 minutes. A neutral
observer can tell who is winning from the render alone, without being told the score.

### Phase 9 — polish · ~4 evenings

- [ ] Tier 3 effects
- [ ] Quality tier setting
- [ ] Audio
- [ ] German UI strings (code and docs stay English)

**DoD:** tier 1 holds 30 fps on the target device. Asset budget of §7.5 met.

### Phase 10 — durability · ~3 evenings

- [ ] Keyframe snapshots, RLE/delta compressed, within the §6.4 caps
- [ ] Reconnect
- [ ] Spectator mode
- [ ] Replay file format and native replay verifier CLI

**DoD:** a client killed mid-match rejoins and converges. A spectator joining at any
point sees a correct world. A replay file reproduces a recorded match bit-identically.

---

## 13. Failure modes to watch

The most likely ways this project dies, in order:

1. **GPU-side simulation.** Compute shaders or ping-pong render targets are the
   obvious performance path for water and materials, and they will silently destroy
   determinism. Noita simulates every pixel and is a single-player game *because of
   this*; its co-op mod is notoriously fragile. Causation, not coincidence.
2. **Snowball.** Direct conquest amplifies positive feedback: take territory → more
   mana → more power → take more territory. The counterweights are mana from bounded
   territory (§4.6), zero-sum influence (§4.5), and tides that keep taking land back
   (§5.5). If any of the three is quietly reverted for feel reasons, the snowball
   returns. Load-bearing, not polish.
3. **Combat resolution ordering.** The single highest-risk determinism site (§4.7).
   It is also the one that will pass casual testing and fail in a real match, because
   simultaneous multi-walker contacts are rare early and constant late. Phase 5's DoD
   stress test exists specifically for this.
4. **Design risk deferred to Phase 8.** The core loop — shape terrain, people react,
   tides compress the map, peoples collide — is assumed fun and is not validated
   until Phase 8. That is a deliberate, accepted decision. Noted once, here, so it is
   on the record rather than a surprise.
5. **A long-lived Lobby Durable Object.** The obvious implementation keeps the DO open
   for the match because it is convenient — and it caps the whole platform at ~112
   matches/day (§6.6). It will never show up in testing, because two people playing
   one match will not notice. Phase 7's DoD measures for it explicitly.
6. **Developing on a strong machine.** Every performance budget in this document is
   set against integrated graphics (§7.6). On a workstation GPU none of them will ever
   appear to be violated, so they will quietly rot until someone else opens the game.
7. **Simulation budget creep.** Each new field is another pass over 24k cells at
   30 Hz. Measure before adding; cut `N` before cutting the tick rate.
8. **Genre indecision.** Populous: The Beginning was criticised for wavering between
   RTS and god game. The player steers the world; the people steer themselves. There
   is no third option, and no attack order, ever.
