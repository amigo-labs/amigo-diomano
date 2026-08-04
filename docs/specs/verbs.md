# Verbs, powers and the map manifest

Split from `docs/HANDOFF.md` §5 and §8 (Phase 0). Implemented by
`crates/diomano-sim/src/{powers,tide}.rs` and `web/src/{hand,gestures}.ts`.

---

## Always available

| Verb | Cost | Notes |
|---|---|---|
| Raise / lower land | free | Where ~90% of playtime goes. Direct drag, no gesture. |
| Papal magnet | cheap | Place a flag; population walks toward it. The *only* command in the game. First walker to reach it becomes leader; if the leader dies the magnet drops there. |
| Armageddon | very expensive | Immediately triggers the final tide wave at maximum strength. Stalemate breaker. Deliberately awkward to invoke. |

## Map-gated powers

- **Earthquake** — lowers and dents terrain, with an alternating sign so the
  result is *broken* ground rather than a smooth bowl. Plateaus are what
  settlements need and this destroys them. Nominally a weapon, in practice the
  repair tool for volcano damage, and the only build tool at all on maps where
  raise/lower is disabled. It is the one verb that moves earth without
  conserving it; the mana cost is what pays for that.
- **Swamp** — created on flat ground; swallows walkers that enter.
- **Volcano** — opens a lava vent. Its real function is generative. Do not
  balance it as damage.
- **Flood** — raises global sea level one terrace. **Damages both players**, and
  there is deliberately no per-player sea level for it to be aimed with.
- **Champion** — see `combat.md`.

## Modifiers

Multiply the verb set without adding verbs:

- **Thrown vs. poured** — thrown: large radius at the impact point. Poured:
  small radius directly under the hand.
- **Increased / extreme** — same verb scaled, at proportionally higher cost.
- **One-shot pickups** — free single-use powers lying on the terrain.
  **Not implemented in this run.**

## Map manifest

The map is the ruleset, not just geometry. Pure configuration, no runtime state,
therefore trivially deterministic. Parsed by `powers::parse_manifest` — a
hand-written subset of TOML, because the simulation crate takes no dependencies
and `serde` is explicitly out.

```toml
[world]
n = 64                       # must equal the compiled N — see world.md
seed = 0x5EED
terrain = "archipelago"      # archipelago | pangaea | volcano

[mode]
kind = "conquest"
waves = 7                    # [START]
score = "per_wave"

[mode.tide]
telegraph_ticks = 300        # [START] 10 s visible warning
impact_ticks    = 150        # [START] 5 s surge and recede
recovery_ticks  = 900        # [START] 30 s calm to rebuild
escalation      = 115        # [START] percent per wave, integer
strength        = 48         # [START] first wave's peak, in height units

[powers.earthquake]
enabled = true
cost = 120

[powers.swamp]
enabled = false              # deliberately withheld, as in later Populous worlds

[powers.raise_lower]
enabled = true               # false makes earthquake the only build tool

[ai]
enabled = false              # scripted opponent; this run only
player = 1
```

Errors carry a line number. An unknown key is an error, not a shrug: a manifest
with a typo that silently does nothing is worse than one that refuses to load.

**Phase 6 DoD, asserted:** `powers::a_disabled_power_is_inert` fires a swamp
command with the power disabled and asserts the world does not change, then
enables it and asserts the same command works. Disabling a power in the manifest
removes it from the game with no code change.

An unaffordable power does nothing *and costs nothing*
(`a_power_you_cannot_afford_does_nothing_and_costs_nothing`) — the cost check
and the effect are in the same place, so they cannot drift apart.

## Input: the hand

**No HUD.** The god has no body, only a hand — cursor, matter carrier and
influence indicator in one. Mana, held matter and influence reach are all
communicated diegetically:

- **Held matter** is the visible volume inside the hand, which fills as you dig
  and empties as you build. That is the matter budget of pillar 4, shown as a
  volume rather than as a number.
- **Mana** is the hand's glow.
- **Brush footprint** is a ring on the ground, so you can see what a drag will
  touch before it touches it.
- **Carried material** is the fill's colour: earth, water or lava.

### Controls

| Input | Verb |
|---|---|
| left drag up / down | raise / lower land |
| left click (no drag) | place papal magnet |
| right drag, spiral, then `~` | flood |
| right drag, spiral, then `∧` | volcano |
| right drag, spiral, then `∪` | swamp |
| right drag, spiral, then `Z` | earthquake |
| right drag, spiral, then `+` | champion |
| second spiral while held | increased → extreme variant |
| double spiral, then hold 2 s | Armageddon |
| shift / alt / ctrl while dragging | thrown / increased / extreme |
| `1` `2` `3` | switch the hand to earth / water / lava |
| middle or right drag (no spiral) | orbit the planet |

Raise/lower deliberately has no gesture — it is the constant verb and must stay
frictionless. Armageddon deliberately has the most friction; it is irreversible.

### Gesture recognition

**Sampled on a fixed timer (60 Hz `setInterval`), never per frame.** Black &
White 2 failed to recognise gestures at low frame rates and that failure mode is
avoidable: at 15 fps the sampled path is identical to the one at 60 fps, which
is the Phase 6 DoD stated as a mechanism rather than as a hope.

The path is resampled to 32 points, each segment quantised to one of eight
compass headings, runs collapsed — so a stroke becomes a short string like
`E S W N` which templates match as a subsequence. Scale- and speed-invariant,
and small enough to read.

Recognition is entirely client-side; only the resulting `(verb, modifier)` ever
enters the command stream.

`classify` returns `null` when nothing matches, which is the right answer far
more often than a wrong verb would be: every gesture costs mana and two of them
are irreversible.

## Command wire format

`Command::encode` packs to the 8 bytes of §6.2. The spec lists seven fields
totalling 12 bytes and then says "packed to 8", so a bit layout had to be
chosen:

| bits | field | range |
|---|---|---|
| 0–3 | verb | 16 (11 exist) |
| 4–5 | player | 4 |
| 6–8 | face | 8 (6 exist) |
| 9–14 | modifier | 64 |
| 15–23 | x | 512, so `N` may grow to 512 |
| 24–32 | y | 512 |
| 33–63 | tick | 2.2 years at 30 Hz |

Nothing in the simulation depends on this layout yet — the sim advances by
`tick(commands: &[Command])` and the wire format exists so netcode is later a
transport concern and nothing more.
