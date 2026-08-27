# Pacing and safety nets

**Status: design, not yet implemented.** Every other file in `docs/specs/`
describes code that exists. This one describes five rule changes that do not
exist yet, agreed on 2026-08-27, and it is written down first because the
changes touch the state hash and therefore every fixture in the repository —
that is not a thing to discover halfway through.

Supersedes the playtest-balance paragraph at the end of `PLAN.md`.

---

## The defect

A player who opens the game and looks around for two minutes has lost, without
having made a mistake. The chain is short and entirely in the code:

1. `ai.rs:174` — the scripted opponent leaves the teaching curriculum after
   **one** pass (`script_ticks()` is about 19 s) and switches to `WAR_SCRIPT`.
2. `ai.rs:138` — the war move drops the magnet on the enemy's strongest
   settlement. The army walks.
3. `combat.rs:253` — `besiege` subtracts walker strength from
   `settlement.progress` every tick, with no floor.
4. `settlements.rs:203` — `progress < 0` razes the settlement.
5. `flowfield.rs:186` — influence is projected from live settlements and from
   nothing else. No settlement, no influence.
6. `tide.rs:173` — `check_sudden_death` turns zero influence into an outcome in
   the same tick.

The codebase already knows: `settlements.rs:1236` records that a player who
never acts "still loses to the marching army around tick ~4,200", and files it
under "the opponent legitimately winning a war nobody contested". That reading
is defensible for the _rule_ and wrong for the _game_, which is what this
document changes.

## Why it inverts the design

The win condition is `tide.rs::score_wave`: habitable cells under your
influence, sampled at each wave peak. That is a terraforming score — shape land,
flatten plateaus, let settlements grow, take ground back from the sea.
`simulation.md` states the same intent from the other direction ("lava is a
construction verb, not a destruction verb"; "mana accrues from held habitable
territory, not from raw population count", the deliberate divergence from
Populous and the primary snowball fix).

Sudden death sits beside that scoring as a short circuit, and it makes the army
rush the _fastest_ route to a win. So the mode's stated core loop and its
fastest strategy point in opposite directions. Removing the short circuit is not
a difficulty setting; it is what makes the score the game.

Two properties are deliberately **not** weakened:

- **Influence stays zero-sum** (`flowfield.rs:171`). Gaining ground still means
  taking it.
- **Sudden death still exists.** It stops meaning "your huts are gone" and comes
  to mean "your land is gone" — which is a statement about terrain, i.e. about
  the verb the game is built on.

---

## 1. A siege cannot raze

Walkers push a settlement down to hut level and no further. Taking ground
permanently is terraforming work.

```rust
/// A siege subdues; only broken ground razes.
pub const SIEGE_FLOOR: i32 = TIER_THRESHOLD[1]; // 60
```

`besiege` clamps, and does not repair what the terrain already broke:

```rust
let floor = SIEGE_FLOOR.min(w.settlements[slot].progress);
w.settlements[slot].progress = (w.settlements[slot].progress - damage).max(floor);
```

`combat::ticks_to_raze` **already computes against this floor**
(`combat.rs:290`) — the bound exists in the documentation function and is
missing from the mechanic. Rename it `ticks_to_subdue`; its only callers are
tests.

What still razes, unchanged: `settlements.rs:190` — a footprint that is no
longer flat loses `BUILD_RATE * 2` per tick and dies below zero. Earthquake,
flood, digging the ground out from under it. The reaction window of §4.7 is what
that path is for, and it keeps it.

Tests: replace `a_besieged_settlement_falls_slowly_enough_to_save` with
`a_besieged_settlement_is_pushed_to_hut_level_and_no_further` and
`broken_ground_still_razes_what_a_siege_cannot`.

## 2. The home core

`project_for` seeds settlements. It also seeds the spawn pedestal itself:

```rust
/// The home core: the spawn pedestal projects influence like a hut for as
/// long as it is habitable. A thread, not a foundation — enough that sudden
/// death means "my land drowned" instead of "my huts fell", too little to
/// live on.
pub const SANCTUARY_STRENGTH: i32 = 1; // contribution 1 * INFLUENCE_REACH = 6
```

Seeded at `settlements::STARTS[player]` in the same bucket level as a tier-1
settlement, and only while `w.habitable(cell)`. It is an ordinary contribution
through the ordinary zero-sum combine, so nothing about §4.5 changes.

Symmetric: the opponent gets the same core. Deliberate — a one-sided floor would
mean the player can still rush the AI out of the match, and then the fix has
produced an easier game rather than a different one.

Tests: `the_home_core_keeps_influence_alive_when_every_settlement_is_gone`,
`a_drowned_home_core_projects_nothing` (the condition under which sudden death
still fires).

## 3. The grace countdown

Zero influence starts a clock instead of ending the match.

```rust
/// Consecutive ticks with no influence at all, per player. Sudden death
/// decides at GRACE_TICKS; one cell won back resets it.
pub doom: [u32; PLAYERS],

const GRACE_TICKS: u32 = 90 * TICK_HZ; // 2,700
```

`check_sudden_death` keeps its cell scan and changes only its verdict:
`held > 0` resets, `held == 0` increments while armed, `doom >= GRACE_TICKS`
decides. Both players at zero past the window is the draw that
`(0, 0) => outcome = 3` is today.

`doom` **goes into `state_hash`** (`world.rs:1236`, beside `tide` and
`outcome`) and into `zeroed()`. A timer that diverges outside the hash is
invisible until it lands as an outcome, which is exactly the desync class
`determinism.md` rules out.

New wasm exports, in the style of `dio_tide_phase`: `dio_doom_ticks(player)`,
`dio_grace_ticks()`.

Tests: `losing_all_influence_starts_a_countdown_and_not_a_defeat`,
`the_countdown_resets_when_ground_is_won_back`,
`the_countdown_ends_the_match_when_it_runs_out` — replacing
`losing_all_influence_ends_the_match_immediately`.

## 4. Sudden death is armed by the first wave

```rust
/// Sudden death is only armed once the first wave has scored. Before that
/// there is no standing to cut short — and a match that ends during the
/// opening is a dissolved spawn, never a lost war.
fn sudden_death_armed(w: &World) -> bool {
    w.tide.wave >= 1 || w.tide.phase == TIDE_RECOVERY || w.tide.phase == TIDE_DONE
}
```

`doom` does not accumulate before that (rather than accumulating unwatched,
which would fire one second after arming).

On `MapConfig::DEFAULT` the first peak is tick 3,900 (2:10). With the window,
the earliest possible defeat is tick 6,600 (3:40), and only with the home core
drowned as well. The minimum-match-length asserts in `settlements.rs:1276`,
`main.rs::MIN_MATCH_TICKS` and `screenshot.mjs:199` stay: they cost nothing and
now guard a property the simulation itself guarantees.

## 5. The opponent escalates with the tide

Two changes in the interpreter, none in the tables.

- **School until the sea has spoken.** The `PHASE_WAR` transition (`ai.rs:174`)
  also requires `w.tide.wave >= 1`. Until then the curriculum repeats, which is
  the part that teaches the verbs, and `reanchor` keeps it next to whatever the
  opponent has built. The first two minutes belong to learning and building.
- **The strike lands later than the march.** `Lesson` gains `min_wave: u8`
  beside `needs_reserve` and `telegraph_only`; the earthquake in `WAR_SCRIPT`
  (`ai.rs:144`) sets `min_wave: 2`. Wave 1 is economy and marching, wave 2 is
  strikes. Same gate shape as `telegraph_only` (`ai.rs:198`), so the same
  skip-the-move-rather-than-half-hold path.

Tests: `after_one_curriculum_pass_the_opponent_goes_to_war` needs a wave now
(the fast tide from `tide.rs::tidal_world` on top of `ai_world`); new
`the_opponent_stays_in_school_until_the_first_wave_has_landed`.

---

## What the player sees

A grace window nobody can see is not a rescue, it is a delay. `hud.ts` gains a
fourth line that exists only while `dio_doom_ticks(player) > 0`:

> **Dein Volk hat kein Land mehr — 74 s**

Counting down, gone again the moment the counter resets. One `banner()` on the
0 → non-zero edge ("Dein Volk verliert den Boden"). The territory bar
(`hud.ts:206`) is unchanged.

The opponent's counter is deliberately **not** shown: it would be a victory
readout, and §8 is spent sparingly. Your own emergency is the only one you need.

## Measuring it

Two instruments, because the two questions are different: _do the numbers hold
across seeds_, and _is it any fun_.

**`diomano-cli sweep`** — batch over seeds and terrains, one line per match: end
tick, cause, territory share at each wave peak, settlement balance. Player
behaviour `idle` (no commands at all, opponent on — the case this document is
about) or `scripted` (`demo_script` one-sided, as `trace --ai` runs today).
Cause is derived from state, not from a new field: `tide.phase == TIDE_DONE`
means the wave score decided it, anything else is sudden death — the same
derivation `game.ts:232` uses for the end card. Non-zero exit when a match is
decided before the first wave peak, or when an idle player loses before wave 2.
That turns "idling does not lose instantly" into a command instead of an
opinion. `justfile` recipe: `sweep seeds="8"`.

**`web/tools/play.mjs`** — Playwright against the real client.
`screenshot.mjs` already has the static server, the Chromium resolution and the
`window.diomano.sim` handle (`game.ts:298`); both should share them from
`web/tools/harness.mjs`. It plays through `sim.push(...)`, the same path as
`game.ts:125`: dig beside the spawn until the hand is full, flatten a 7x7 block,
set the magnet. Deliberately dumb and readable — it is not there to play well,
it is there to show whether deliberate terraforming carries inside the game's
time budget. Screenshots at the moments that matter (wave incoming, impact,
grace countdown live, end card) and a JSON sample every 30 ticks: tick, mana,
territory share, settlements per tier, doom ticks.

## Fixtures

Changes 1 to 5 all move the state hash from tick 0. In order: `just record`,
`just record-corpus`, `just verify`, `just verify-cross`, `just verify-corpus`.
Say in the commit why the hashes moved — `justfile:152` asks for that, and here
the answer is a rule change and not a red test.

One risk, named rather than assumed: §6.3 wants at least 200 combat resolutions
(`main.rs:50`). Change 1 removes destruction from combat, not resolution
(`combat.rs:241` counts walker against walker), and settlements that survive
longer spawn more walkers, so the count should rise. Checked on the
`record-corpus` run, not assumed.

## The regression this is all for

New in `settlements.rs`, beside `the_default_match_survives_the_opening_war`:

```rust
an_idle_player_survives_the_first_two_waves_against_the_scripted_opponent
```

Roughly 10,000 ticks with `ai_enabled: 1` and an empty command slice, asserting
`outcome == 0`. It is the exact inverse of the note at `settlements.rs:1236`,
and that note gets rewritten by the same change.

## Open questions for the playtest

- Is `SANCTUARY_STRENGTH = 1` the right thread? Too strong and the core becomes
  a foundation to dig in on.
- Are 90 seconds enough to found a settlement from a bare home core? A 3x3
  plateau is 60 progress at `BUILD_RATE = 2` — 30 ticks of building, but
  flattening it by hand takes longer. Measure it.
- If a siege cannot raze, earthquake (cost 200) becomes the only real attacking
  move. Too expensive, or too cheap?
