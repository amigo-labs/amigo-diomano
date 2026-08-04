# Balance research: Populous (1989) and Populous II (1991)

HANDOFF §12, Phase 2 research task. The instruction was explicit:

> Do not invent values; mark gaps `TODO`.

Numeric balance values are facts, not protectable expression. No prose is copied
and no original asset is used; constants defined in the HANDOFF are diomano's own
and need no sourcing.

---

## The headline finding

**The numbers are not published.** Both manuals and the strategy guides describe
the systems qualitatively and give almost no quantities. This is not a gap in the
search; it is what the sources are.

- The Populous manual "emphasises strategic mechanics qualitatively but avoids
  quantitative balance numbers".
- The Populous II manual describes effect costs only in relative terms: "great
  effects like tidal waves and earthquakes are expensive. A lesser effect like
  lowering and raising land costs little."
- popre.net's competitive material is overwhelmingly about **Populous: The
  Beginning**, which HANDOFF §1 explicitly rejects as a reference because it
  broke pillar 1 by letting the player steer a shaman directly. Its balance
  numbers are therefore about a different game with a different control model
  and are not transferable.
- The OpenPop notes repository is an index of tools and projects, not a
  reverse-engineered constants table.

### What that means for diomano

§2 assumes the originals' balance numbers can be researched. For **mechanics**
that is true and productive — see below. For **quantities** it is largely not,
so every numeric `[START]` in the HANDOFF has to be settled by playtest rather
than by citation. That changes the plan: the Phase 8 playtest is not a
confirmation step for numbers sourced here, it is the *only* source for them.

Recorded so nobody repeats this search expecting a table.

---

## Mechanics that are sourced, and what they confirm

Confidence: **direct** = read from the manual text; **secondary** = from a guide
or a summary of one, not verified against the primary.

| # | Finding | Source | Confidence | Bearing on diomano |
|---|---|---|---|---|
| 1 | Settlements "are erected in areas of **5×5 or more** contiguous fields" | Populous manual (Amiga) | direct | The 5×5 house tier is the original's *minimum* settlement. diomano's 3×3 hut is below anything Populous had — deliberately, to make rolling terrain productive rather than barren. |
| 2 | "Castles increase your population the fastest… also the most effective fighters. To create a castle, flatten the land widely around any dwelling." | Populous II manual | direct | Confirms the wide-versus-tall axis of §4.2 *and* that tier drives combat strength, not just population. §4.6's one-number-three-consequences design matches the original's intent. |
| 3 | "Mana comes from the pious worship of your followers — the more worshippers you have, the greater your Mana." | Populous II manual | direct | This is precisely what §4.6 diverges from. The divergence is now against a **sourced** original rather than an assumed one, which strengthens failure mode 2's argument: the original really did tie power to headcount, and really does snowball. |
| 4 | Effects unlock left to right as mana rises; raise/lower needs least, Armageddon most | both manuals | direct | diomano's cost-only gating (open item 4, "leaning toward cost-only") is a simplification of a real unlock ladder, not an invention. |
| 5 | "The first walker to arrive at the papal magnet is your leader." Leader at the magnet is invincible, surrounded by blue holy fire. | Populous II manual | direct | §5.1's leader rule is verbatim from the original. Invincibility while standing on the magnet is **implemented**; see TODO-7. |
| 6 | Turning a leader into a hero means "you'll need to establish a new leader by selecting the Go To Papal Magnet command" | Populous II manual | direct | §4.7's champion rule — the magnet transfers and you have no leader until a walker touches it again — is the original's rule exactly. |
| 7 | "Any time two of your walkers bump into each other, they combine to make one stronger walker" | Populous manual | direct | diomano did not do this — walkers were independent and combat was per-pair attrition only (§4.7). Now **implemented**, which is what makes the papal magnet a *stacking* tool rather than just a destination. See TODO-8. |
| 8 | Plague victims give no mana | Populous II manual | direct | Plague is not a diomano verb. Noted only because it shows mana was per-*healthy*-follower. |
| 9 | Effects can be strengthened by spending earned experience points at the Deity Creation screen | Populous II manual | direct | A progression system diomano rejects. In a symmetric duel it would be arbitrary placed furniture, same argument as §2's rejection of totems. |
| 10 | Populous II has **30** Divine Intervention Effects across categories | Populous II manual | direct | diomano has 8 powers. §5.4's point stands: Bullfrog got variety from per-map availability, not from a large verb count. |
| 11 | The mana bar has 9 levels; level 0 cannot raise or lower land, level 1 raises a small plot, level 2 moves the papal magnet given a leader | Populous SNES strategy guide | **secondary** | The only quantised mana scale found anywhere. 9 levels, with raise/lower at the very bottom — consistent with #4. Not verified against the Amiga original. |
| 12 | Land is raised and lowered **square by square**, left button raises and right lowers | both manuals | direct | diomano uses a drag rather than per-click, and one terrace step per tick. A deliberate feel change, not an oversight. |
| 13 | Some worlds disable raising and/or lowering | Populous II manual | direct | Confirms §5.4's `powers.raise_lower.enabled = false` is an original mechanic, not a hypothetical. |

---

## Numeric gaps

Every one of these is `TODO`. The blocking input is named for each.

| id | Value | Blocking input |
|---|---|---|
| TODO-1 | Mana cost per effect, in any absolute unit | Not in any manual or guide found. Would need disassembly of an original binary, or a decompilation project that has already done it. The OpenPop index did not point to one. |
| TODO-2 | Mana accrual rate per follower per unit time | Same. |
| TODO-3 | Population capacity per settlement tier | Manuals give tier *ordering* (hut → castle) and relative growth rate, never counts. |
| TODO-4 | Walker strength and hit points; damage per combat tick | Populous shows strength as coloured bars, never as a number. |
| TODO-5 | Match length and typical population at parity | Would come from recorded competitive matches. popre.net's archive is Populous: The Beginning, so it does not apply. |
| TODO-6 | Angle of repose / erosion rates | Not applicable — these come from From Dust, which ships no numbers either. Pure playtest. |

## Implementation gaps this surfaced — both now closed

Not numbers — mechanics diomano was missing that the originals had, found while
looking for numbers. Each was a decision rather than an oversight, and both have
now been decided; the arguments are kept as recorded, because the reasoning is what
makes the decision reviewable.

| id | Gap | Argument for | Argument against |
|---|---|---|---|
| TODO-7 | **Leader is invincible while standing on the papal magnet.** *(implemented)* | It is the original's rule, and it makes the magnet a defensible rally point rather than a death trap — placing it forward is currently strictly risky. | Adds a positional invulnerability rule to combat, which is the highest-risk determinism site. Cheap to implement, and cheap to get subtly wrong. |
| TODO-8 | **Walkers merge into one stronger walker on contact.** *(implemented)* | This is what made the magnet a *stacking* tool in the original: gather, combine, then march. Without it, "place the magnet inside your castle walls and influence your walkers to gather there, combining for strength" — the manual's own advice — has no analogue in diomano. | It changes walker count dynamics and interacts directly with the §4.7 resolution order. It would need its own stress test before being trusted. |

**Both are now implemented** (`crates/diomano-sim/src/combat.rs`), on an explicit
decision rather than by drifting into it. Each brought its own defect, and neither
would have shown up in a short fixture — which is exactly the failure mode §13
predicted for combat, arriving on schedule:

| id | Implemented as | What it cost to get right |
|---|---|---|
| TODO-7 | `leader_on_own_magnet`; suppresses incoming damage only, so the leader still deals its strength. Both walkers' predicates are read before either `hp` is written. | Nothing structural. Evaluating the predicate after a write would have made a pair's outcome depend on which walker the loop reached first — the same trap the strengths were already avoiding. |
| TODO-8 | A `merge` pass between bucketing and fighting. The leader always absorbs and is never absorbed; champions take no part; strength and hp saturate at `MERGE_MAX_STRENGTH`. | Three defects, below. |

**TODO-8's three defects, in the order they were found:**

1. **A spawn/merge loop.** Releasing the absorbed walker's population slot let
   `spawn_population` refill it the next tick; the new walker landed on the same
   cell and merged again. Measured: **16,928 merges against two surviving
   walkers** over 20,000 ticks. Fixed by having a merge *carry* population rather
   than spend it (`Walker::pop_carried`), which is also the more honest model — the
   people are still in the field, inside the walker that ate them.
2. **Army collapse.** Every walker follows the same flow field to the same magnet,
   so they all meet and fold into one. A player's entire army became a single
   capped walker and population growth stopped meaning anything. Mitigated by
   gating absorption on the cap rather than only clamping the result: a walker at
   `MERGE_MAX_STRENGTH` cannot absorb more, so a bigger population fields more
   walkers — which is what makes gathering worth doing, the original rule's whole
   point.
3. **Unbounded champions.** Not a merge bug, but found by the same corpus:
   `make_champion` triples strength, and nothing stopped it re-promoting a walker
   that was already a champion. Repeated casts compounded **2 → 6 → 18 → 54 → 162
   → 255**, past `MERGE_MAX_STRENGTH` and every other bound in the game. A second
   cast now promotes a second walker, or does nothing.

`MERGE_MAX_STRENGTH = 16` is `[START]` and a **playtest** value, not a sourced
one — TODO-4 above records that walker strength was never published as a number
anywhere, only as coloured bars. It is set at roughly twice `TIER_STRENGTH`'s
maximum so stacking is worth doing and still finite. Phase 8 settles it.

---

## Sources

- [Populous — Amiga manual and docs, Lemon Amiga](https://www.lemonamiga.com/games/docs.php?id=1259)
- [Populous II: Trials of the Olympian Gods — instruction manual (PDF), popre.net archive](https://ts.popre.net/archive/Downloads/Docs/populous2.pdf) — 82 pages, read directly
- [Populous II — Amiga manual and docs, Lemon Amiga](https://www.lemonamiga.com/games/docs.php?id=1262)
- [Populous — SNES strategy guide by Jabu-Jabu, GameFAQs](https://gamefaqs.gamespot.com/snes/588581-populous/faqs/9758) — secondary; the site blocks direct fetching, so finding #11 comes from a search summary of it and is unverified
- [Populous II — strategy guide by populator, GameFAQs](https://gamefaqs.gamespot.com/snes/570900-populous-ii-trials-of-the-olympian-gods/faqs/29605) — not readable, 403
- [OpenPop/notes](https://github.com/OpenPop/notes) — an index of tools and projects, no constants
- [Populous Wiki — Multiplayer, popre.net](https://wiki.popre.net/Multiplayer) — Populous: The Beginning, rejected as a reference by §1
