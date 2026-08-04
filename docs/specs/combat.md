# Combat

Split from `docs/HANDOFF.md` §4.7 (Phase 0). Implemented by
`crates/diomano-sim/src/combat.rs`.

---

Walkers fight autonomously on contact. The player never issues an attack order
(pillar 3); the player decides where the magnet is and what the terrain allows.

**Netcode note:** autonomous combat is simulation, not player input. It requires
no frame-accurate response, so the pillar-2 latency argument is unaffected.

## Walker combat

All values `[START]`:

```
walker.strength = spawning settlement tier_strength
walker.hp       = strength * 16
```

Two hostile walkers in the same cell each lose the opponent's `strength` in hp
per tick. At `hp <= 0` the walker is removed. The stronger survives with a
remainder, so attrition is meaningful and stacking matters.

**No randomness.** `combat::combat_has_no_randomness` asserts the simulation
PRNG is untouched by a full resolution, so nobody can quietly reach for it. If
randomness is wanted later it must come from the seeded sim PRNG only, and that
test is what will force the conversation.

Damage within a pair is applied **simultaneously**: both strengths are read
before either hp is written. That is what makes "the stronger survives with a
remainder" true rather than "whoever is listed first wins".

## Resolution order — the determinism trap

§4.7, §10 and failure mode 3 all name this as the highest-risk site in the
codebase, and for a specific reason: it will pass casual testing and fail in a
real match, because simultaneous multi-walker contacts are rare early and
constant late.

Specified exactly, and implemented exactly:

1. Iterate cells in fixed flat-index order (face, then y, then x).
2. Within a cell, sort participating walkers by walker id ascending.
3. Resolve pairwise in that order.

**Step 2 is free rather than trusted.** Walkers live in a slot array indexed by
id; the bucketing pass visits them in id order; a counting sort is stable. Every
bucket therefore comes out id-ascending *by construction*, and no comparator
exists that could have been written without a tiebreaker.
`buckets_come_out_id_ascending_without_a_sort` asserts the property directly.

Never iterate a collision structure's natural order. Never sort without id as
final tiebreaker.

### The test that pins it

`pairs_resolve_in_ascending_id_order` builds a deliberately order-sensitive
scenario: walker 0 dies partway through its pair list, so whether walker 1 was
already fought decides walker 1's final hp (15 versus 20). The same scenario is
then run with the two defenders' ids swapped, and the *other* walker is the one
left untouched. A resolution order that is anything but ascending-by-id fails
one of the two.

### The stress test

`stress_200_simultaneous_contacts_is_deterministic` places 200 contested cells
across all six faces, runs 60 ticks of resolution, and asserts the state hash is
identical across **100 runs from one seed**. It then separately asserts that a
fighting scenario changes the hash at all — a hash that matches because nothing
happened would prove nothing.

## Settlements fall gradually, never instantly

Enemy walkers inside a settlement footprint reduce its build progress by
`1 * strength` per tick. When progress drops below the current tier's threshold
the tier drops; when it runs out entirely the settlement is razed.

Gradual decay is required, not cosmetic: it creates the reaction window in which
the god can intervene with terrain — swamp the approach, reroute water, cut the
path, raise a wall. Instant destruction would hollow out pillar 3, because there
would be nothing to respond to.

`a_besieged_settlement_falls_slowly_enough_to_save` puts three strength-4
attackers inside a fortress and asserts it survives at least 30 ticks (one
second) and falls within 3,000 (100 seconds) — a window, bounded at both ends,
because a siege that never ends is as broken as one that ends instantly.
`ticks_to_raze` exposes the arithmetic so the property can be asserted rather
than eyeballed.

## Champion

The leader becomes an autonomous warrior who seeks enemy settlements and razes
them until killed. The magnet transfers to the champion, so the player has no
leader until a walker touches the magnet again. Any number can be created while
mana allows.

A champion finds the enemy by following the **opponent's flow field**, which
already points at exactly the targets it wants. No second search, no
special-cased pathfinder, and it automatically tracks the opponent's magnet.

With combat in the game the champion is not an outlier against pillar 3 — it is
simply the escalation lever. Open decision resolved: keep it.
