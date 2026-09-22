# Prompt: fix and optimize

A reusable prompt for an agent session (Claude Code or similar) whose job is to
find and fix defects in diomano and make it faster, without breaking the one
property the architecture exists for: bit-identical determinism between the
native build and the browser. Paste everything below the rule.

---

You are working on **diomano**, a browser 1v1 god game on a cubed-sphere planet.
The simulation (`crates/diomano-sim`) is `no_std`, integer-only and
dependency-free; it compiles to native and to `wasm32-unknown-unknown` from the
same source. `crates/diomano-wasm` is a thin `extern "C"` shell,
`crates/diomano-cli` is the replay verifier and perf harness, and `web/` is the
Three.js client (renderer, camera, hand, power menu, audio).

Your task: **find and fix real bugs, then make measured performance
improvements**, and leave the repo in a state where every check is green.

## Read first, in this order

1. `README.md` — layout, controls, what is deliberately absent.
2. `PLAN.md` — what is done, the seven recorded decisions, and `## Next`.
3. `docs/specs/determinism.md` — the rules and the four checks.
4. The `docs/specs/*.md` file for whatever area you touch. `docs/HANDOFF.md`
   is the specification and wins every disagreement.
5. `justfile` and `.github/workflows/ci.yml` — what "green" means.

## Hard constraints — never violate

- **Determinism is the product.** No floats in simulation state, no
  `HashMap`/unordered iteration, no allocation-order or pointer-dependent
  behaviour, no platform-dependent arithmetic in `diomano-sim`. The only float
  code allowed there is the contained meshing path documented in
  `docs/specs/determinism.md`.
- **Do not collapse the crate split.** `diomano-sim` must not learn about wasm,
  the browser or Three.js.
- **Fixture hashes are evidence, not snapshots.** If `just verify`, a
  `verify-match` or `verify-cross` fails, the code is wrong until proven
  otherwise. Regenerating `fixtures/*.hashes` (`just record`,
  `just record-corpus`) is a design decision: only do it when a change is
  *intended* to alter simulation behaviour, do it in its own commit, and say
  in the message which behaviour changed and why. Pure refactors and
  optimizations must leave every hash unchanged.
- **Zero warnings.** `just check` runs clippy with `-D warnings`, rustfmt,
  biome, `tsc --noEmit` and the import-cycle check. Never silence a lint,
  add `#[allow]`, `// @ts-ignore` or a biome ignore to get green — fix the
  cause.
- **Never skip, weaken or delete a test** to make it pass. A failing test is a
  bug report.
- **Stay in scope.** No netcode transport, WebRTC, Durable Objects, lobby,
  menus, settings screens or external assets (see README "What is not here"
  and HANDOFF §7.5's CC0-only clause). The pacing rule changes in
  `docs/specs/pacing.md` are designed but unimplemented; do not implement them
  as a side effect of a "fix" — they move the fixtures and are their own task.
- **Performance claims need numbers.** §7.6's reference floor is an office
  machine with integrated graphics; a number from this machine is an upper
  bound, and you must say so.

## Step 1 — baseline

Run and record the output of each before touching anything:

```sh
just check
just verify
just verify-cross
just verify-lockstep
just verify-boot
just verify-input      # slow: software renderer
just perf              # per-pass ms breakdown, save it
```

If anything is already red on a clean checkout, that is your first bug. Note
it, root-cause it, and fix it before anything else.

## Step 2 — find bugs

Look for defects, not style. Rank by impact on a player or on determinism.
Where to look, roughly in order of how this project's regressions have
actually arrived (see recent `git log`):

- **Input layer** (`web/src/keys.ts`, `hand.ts`, `verbs.ts`, `camera.ts`,
  `radial.ts`): stuck keys on blur / `visibilitychange`, key repeat, modifier
  handling (alt/ctrl are deliberately not modifiers), pointer capture on
  right/middle drag, picking the wrong cell near cube seams or at grazing
  camera angles, taps lost or doubled across ticks.
- **Boot and bundle** (`main.ts`, `game.ts`, `loop.ts`): import cycles, module
  evaluation order, wasm loading and memory growth invalidating typed-array
  views onto wasm memory.
- **Simulation edges** (`seams.rs`, `world.rs`, `water.rs`, `materials.rs`,
  `walkers.rs`, `combat.rs`, `settlements.rs`, `powers.rs`): cube corners and
  seam crossings, matter conservation under every verb (raise, lower, pickup of
  water/lava, thrown/brush sizes), integer overflow and truncation, boundary
  indices, counters that leak into the state hash (`the_census_is_not_hashed`).
- **Renderer/audio** (`web/src/renderer/*`, `web/src/audio/*`): GPU resources
  never disposed, per-frame allocations, pooled views that go stale, tier-1 vs
  tier-2 divergence, audio nodes that are never stopped.
- **Docs that disagree with code**: a spec row that no longer matches the sim
  is a bug in one of them; decide which, and fix it.

For each bug: write a failing test or a harness check that reproduces it
**first** (Rust unit test in the relevant module, or an assertion in
`web/tools/verify-*.mjs`), then fix it, then show the test passing.

## Step 3 — optimize

Only after the bug pass. Use `just perf` (12 ms simulation budget, §4.1) and
the client's own frame timing. Pick the largest measured pass, not the one
that looks slow. Candidates, to verify rather than assume:

- simulation passes that run on ticks their predicates rule out;
- meshing work repeated for unchanged chunks;
- per-frame allocations and GC churn in `renderer/` and `loop.ts`;
- draw calls, instancing and material count in tier 2;
- wasm size (`just wasm` prints raw and gzipped bytes).

Each optimization is its own commit with before/after numbers from the same
machine in the message, and **every fixture hash unchanged**
(`just verify`, `just verify-cross`, and at least one `just verify-match`).

## Step 4 — prove it

Before every push, all of this green, and paste the summary:

```sh
just check
just verify && just verify-cross && just verify-lockstep
just verify-boot && just verify-input
just verify-match 00
just perf
```

Re-read your own diff adversarially: what would CI reject, and what would a
reviewer who cares only about determinism object to?

## Commits and docs

- Conventional prefix with area, in the existing voice:
  `fix(input): …`, `perf(sim): …`, `fix(tools, docs): …`. Subject says what
  now *behaves*; body says why it was wrong, how it was found, and how it was
  verified.
- One logical change per commit. Keep fixes minimal; do not widen the PR with
  unrelated refactors.
- Update `PLAN.md` and the relevant `docs/specs/*.md` when behaviour, a
  measured value or a test count changes (the test count in PLAN's
  "Machine-checkable acceptance" block included).

## Report back

End with a short table: each bug (symptom, root cause, test that now guards
it, commit), each optimization (pass, before → after ms, commit), anything you
found but deliberately did not fix and why, and anything that needs a human
decision — recorded, not silently resolved, in the style of PLAN.md's
"Conflicts and decisions needing a human".
