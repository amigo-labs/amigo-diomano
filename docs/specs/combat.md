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

## The leader is invincible on its own papal magnet

Populous II's rule verbatim (`balance-research` finding 5, TODO-7): the leader
standing on the magnet is untouchable, surrounded by blue holy fire.

It earns its place rather than being nostalgia. Without it the magnet — the one
positional decision the player gets over their walkers — only ever argues for
caution, because placing it forward is strictly risky. With it a forward magnet is
a defensible rally point, and the decision has two sides.

Invincibility suppresses only *incoming* damage. The leader still deals its
strength, which is what makes the holy fire a threat rather than a bunker.

The predicate is read for **both** walkers of a pair before either `hp` is
written, for the same reason the strengths already were: evaluating it after a
write would let the pair's outcome depend on which walker the loop reached first,
and "the stronger survives with a remainder" would quietly become "whoever is
listed first wins".

`a_leader_off_its_magnet_is_mortal` and
`invincibility_does_not_cross_to_the_other_players_magnet` exist so the rule
cannot degenerate into "leaders are invincible", which would make a forward magnet
free instead of a decision.

## Friendly walkers merge on contact

Populous's rule (`balance-research` finding 7, TODO-8): two of your walkers that
bump into each other combine into one stronger walker. It is what made the papal
magnet a *stacking* tool — gather, combine, march — and without it the manual's own
advice had no analogue here.

`merge` is its own pass, between bucketing and fighting, not inline in `fight`:
merging kills walkers, and `fight` walks `bucket` indices that would go stale
underneath it. It uses the §4.7 order for the same reason combat does — cells in
flat index order, id-ascending within a cell, which the bucket already guarantees
by construction.

**The leader always absorbs and is never absorbed.** Not a style choice:
`walkers::remove` drops the papal magnet when the walker it removes is the leader
(§5.1, "if the leader dies the magnet drops there"), which is right for a death and
wrong for a merge. Keeping the leader on the absorbing side holds
`magnet[p].leader` valid without teaching `remove` about merging.

**Champions take no part**, absorbing or absorbed. A champion is a unit a verb was
spent on; merging it away would make a power's effect depend on where walkers
happened to be standing.

**A walker already at `MERGE_MAX_STRENGTH` cannot absorb more.** This is what keeps
an army an army. Every walker follows the same flow field to the same magnet, so
without the gate they all converge into a single walker — measured at one walker
per player for a whole 20,000-tick match, with population growth contributing
nothing once that walker hit the cap. Stopping at the cap means a larger population
fields more capped walkers, which is the original rule's actual point.

**A merge carries population, it does not spend it.** The absorbed walker's
settlement slot stays charged (`Walker::pop_carried`), because its people are still
in the field. Releasing it instead lets `spawn_population` refill the slot the next
tick, the fresh walker lands on the same cell and merges again: 16,928 merges
against two surviving walkers, measured, before this was fixed. Carried population
is released in full when the merged walker dies, or a long match strangles its own
settlements into never spawning again.

Determinism is re-established for friendly contact rather than inherited from the
enemy-contact test: `stress_200_friendly_contacts_is_deterministic` runs 50 cells
of four co-located walkers 100 times, because merging changes walker-count dynamics
and that is exactly what §4.7's guarantee is about.

### A champion may not be promoted twice

Found by the corpus, not by review. `make_champion` triples strength, and nothing
stopped it re-promoting a walker that was already a champion: repeated casts
compounded **2 → 6 → 18 → 54 → 162 → 255**, past `MERGE_MAX_STRENGTH` and every
other bound in the game. A second cast now promotes a second walker, or does
nothing.
