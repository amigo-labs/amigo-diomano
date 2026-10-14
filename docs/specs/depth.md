# Depth: easy to learn, hard to master

**Status: implemented** (October 2026). What the game measured like before the
change, what changed, and how to measure it again. Companion to `pacing.md`,
which made a match *last*; this one is about whether anything worth playing
happens while it does.

---

## The finding

Measured with `just sweep` on the state of `3d6b093`, before any of this:

| Measurement | Value |
|---|---|
| Match length, every match | 33:49 (three waves fifteen minutes apart) |
| Idle player vs. the scripted opponent | **idle won 9 of 12** |
| `demo_script` player vs. the opponent | player won 8 of 12 |
| Combat resolutions, traced matches | 0 in 4 of 6 |
| Mana, both sides | at the 9,999 cap from about minute 10 |
| Longest stretch with no combat, no settlement change, no power cast, no wave peak | the whole 15-minute recovery |

The opponent was a fixed table of lessons aimed at offsets from its own town.
Its digs drowned its own coast, its pours flooded its own plateau, it never
spent the mana it accrued, and on the archipelago — where, by user decision,
no land joins the two spawns — its army never met anyone. A player who did
nothing held more habitable land at each peak than an opponent that worked
for fourteen minutes. Every difficulty level built on that would have been a
label on the same loss.

Two further findings, recorded and deliberately not changed here:

- **New plateaus barely happen.** A settlement needs ground of *exactly*
  equal height; raise and lower move every brush cell by one terrace from
  whatever height it had, so they preserve differences instead of removing
  them. Almost every settlement in a match is one of the starting sites the
  spawn shelf was carved for. Traced: a newcomer who digs beside home and
  pours the hand back out fills it with *water* from the sea next to the
  pedestal and floods their own house. Terrace snapping was tried and did
  not move a measurement; the levelling rule needs its own design pass (see
  *Decisions for a human*).
- **The home pedestal is fragile to a wide quake.** The core cell itself is
  exempt from earthquakes (`powers::earthquake`), but a quake at the
  increased or extreme brush turns the pedestal around it to ash, which
  slides into the sea and takes the core with it within seconds. One cast,
  then sudden death 90 s later. The opponent no longer does it
  (`ai::CORE_CLEARANCE`); a human still can.

## What a match is about now

The score is the habitable land under your influence at each wave peak.
Everything a god can do moves that number, and the planet shows the line that
decides it:

- **The flood forecast.** Dry land the *next* peak will put under water is
  hatched red, with the forecast shore in orange (`tide::next_peak_level`,
  `dio_next_peak_level`, `renderer/planet.ts`). Quiet between waves, pulsing
  through the telegraph. Every raise is a bet against that line.
- **Lift what you hold, take what they hold.** Raising your own coast above
  the line keeps it scoring; digging the enemy's coast below it stops theirs.
  Material is conserved (pillar 4), so the earth for one is the hole of the
  other — the decision is *where* the hole goes.
- **Spend.** Earthquakes break the enemy's best ground; a flood is worth it
  only when the forecast says the enemy has more land just above the line
  than you; armageddon breaks a level score in favour of whoever built higher.
- **Waves every five minutes.** Peaks at 2:10, 7:10 and 12:10, a match in
  13:49 (user decision, `MapConfig::DEFAULT`).

## The opponent

`crates/diomano-sim/src/ai.rs`. Still only commands, one move at a time, held
long enough to watch and followed by a pause. Each decision, in order:

1. **Armageddon** — only when the waves stand level, one natural wave is left,
   and the doubled final wave would go its way where the natural one would not.
2. **Flood** — only between waves, below `FLOOD_CAP`, and when the land it
   drowns at the next peak is mostly the enemy's.
3. **Strike** — earthquake (volcano for the disaster style) on the enemy's best
   town, or with none left on its densest scoring ground; spaced by
   `strike_gap`, never inside `CORE_CLEARANCE` of a home core, gated by a mana
   reserve.
4. **March** (rush style) — the magnet onto the enemy's best town, then
   champions.
5. **Terraform** — with earth in hand, raise where the most own land (and the
   shelf off its own coast) sits just below the forecast line; otherwise dig
   where it costs nobody's score: the shallows, neutral land away from the
   enemy's influence, and — above easy — enemy land that one terrace of
   digging puts under the line. Enemy land that would stay above it is left
   alone: a held dig levels, and levelled ground founds a town for whoever
   holds it. A full hand with nothing to build empties onto its own deep
   shelf.

| | easy | normal | hard |
|---|---|---|---|
| Thinks every | 120 ticks | 45 | 15 |
| Holds a raise or dig | 12 ticks | 24 | 30 |
| Pause after a move | 60 ticks | 24 | 8 |
| Strikes from | wave 2 | wave 1 | wave 1 |
| Strike spacing | 1,800 ticks | 900 | 450 |
| Strike brush | poured | increased | extreme |
| Digs enemy land | never | open ground | also under towns |
| Picks | the first good spot | the best spot | the best spot |
| Floods / armageddon | no / no | yes / no | yes / yes |

Styles modify a level: **turtle** strikes at half the rate, holds its raises
half again as long with half the pause, builds against the *last* wave's line
instead of the next, and never floods or calls armageddon; **rush** marches
and strikes from the start; **disaster** strikes with volcanoes instead of
quakes, from the second wave, floods, and calls armageddon above easy.

## Measuring it

`diomano-cli sweep` (`just sweep`, `just depth`):

- `--profile idle|scripted` against `--level easy|normal|hard`;
- `--profile mirror` — both sides scripted, every ordered pair of levels
  (balanced) and of styles (normal), so each pairing plays from both sides of
  the planet. Prints a level matrix and a style matrix.

Gates, as constants in `crates/diomano-cli/src/main.rs`:

- `SKILL_WIN_PERCENT` 75 — each level beats the one below it this often;
- `DOMINANT_WIN_PERCENT` 65 — no style beats every other style this often;
- the pacing gates of `pacing.md` (nothing decided before the first peak, an
  idle player not beaten before the second, a mean of at least ten minutes).

Each match line also reports combat resolutions and the longest quiet stretch;
the summary counts comebacks (lost the first wave, won the match).

### Results

Idle player vs. each level, 4 seeds x 3 terrains, five-minute cadence:

| Opponent | Opponent wins | Decided by | Mean length |
|---|---|---|---|
| easy | 8 / 12 | waves | 13:49 |
| normal | 12 / 12 | waves, every match to 13:49 | 13:49 |
| hard | 12 / 12 | 9 by sudden death after wave 2, 3 by waves | 9:57 |

Easy losing a third of its matches to an idle player is the map: on those
seeds player 0's spawn starts with more land than the opponent's, and an
opponent that never takes land cannot close that gap. Hard falling under the
ten-minute floor against a player who does nothing is the floor working as
intended — it is defined for the default opponent.

Mirror matches (`just depth`, 2 seeds x 3 terrains per ordered pairing, so
every cell below is 12 matches from both sides of the planet), on the rules
of 2026-10-14 — levelling, the immune platform, fair and rough spawn land, the
rush fix, the turtle and dig changes and the later volcano (`4043797`). All
108 matches were decided on the waves, none by sudden death; 104 ran to 13:49
and 4 ended at 9:40, where hard or disaster called armageddon for the finale.
The longest quiet stretch in any match was 15 s to 2:08.

| row beats column | easy | normal | hard |
|---|---|---|---|
| easy | – | 16% | 0% |
| normal | 83% | – | 8% |
| hard | 100% | 91% | – |

| row beats column (normal level) | balanced | turtle | rush | disaster |
|---|---|---|---|---|
| balanced | – | 50% | 41% | 50% |
| turtle | 50% | – | 41% | 50% |
| rush | 58% | 58% | – | 41% |
| disaster | 50% | 50% | 58% | – |

Every level beats the one below it more often than the gate asks (75%). No
style beats every other, and none is beaten by every other: the widest margin
is 58%, and turtle, the weakest before, wins 41-50% against each.

The runs that got here, and what each caught:

- the first had every hard win as sudden death a minute after the second
  peak — digging too close to a home core (`ec0e3b7`);
- the second lost player 0 at 3:39 on one seed in every pairing: both sides
  dug the same spot in the same tick and the second hand came up full of
  sea, which went onto a core (`9d72024`);
- after the platform became immune to quakes, disaster won everything by
  sudden death at five minutes — its vents were allowed as close as quakes,
  and the platform is not immune to lava (`1cb29a9`);
- after fair spawns, the side that had been *given* land won almost every
  match: the land was one flat sheet of rock, a ready-made plateau
  (`ebebf69`, now rough);
- after levelling, an idle player still out-scored the normal opponent on one
  pangaea seed. Not the spawn balance's radius, as suspected: the opponent's
  own digs on enemy land above the line cut it level, and the enemy founded
  towns on it (`29ac721`);
- once turtle struck from the first wave and digs gave nothing away, disaster
  beat every style 75-83%. Half the vent pace, vents a size smaller, no
  floods, no armageddon: each measured, none below 66%. The first vent was
  what decided — lava over flat land before the second peak cost the enemy
  about a hundred scoring cells — so it now waits for that peak
  (`4043797`).

## Decisions for a human

Decided on 2026-10-14 and implemented:

1. **Levelling** — raise fills the brush's lowest ground first, lower cuts its
   highest (`World::deform`). 0 of 44 uneven sites founded a settlement from
   a held raise before; 31 of 44 now, the median after 5 ticks.
2. **Wide quakes beside a home core** — an earthquake spares the whole 5x5
   platform (`settlements::is_home_platform`), not just the core cell; the
   opponent's strike clearance shrinks to the platform.
3. **Spawn asymmetry** — `settlements::balance_spawns` gives the poorer spawn
   rock above the last wave's line, and for very wide gaps sinks the richer
   one's outermost land into the last wave's flood band, until both hold
   within 95% of each other inside the grown core's reach.
4. **Rush** marches only where the flow field finds a land path from home.
5. **Turtle**, the weakest style, builds for the finale and strikes from the
   first wave at half the rate.
6. **The pangaea outlier** was the opponent's digs, not the spawn balance's
   radius; fixed in the opponent.

Still open:

7. **Swamp** stays disabled (§5.4). Nothing measured here argues for it.
