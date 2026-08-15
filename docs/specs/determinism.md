# Determinism

Split from `docs/HANDOFF.md` §10 and §6.3 (Phase 0).

> Determinism is a design constraint, not an implementation detail. If a feature
> cannot be made bit-reproducible, the feature changes. (Pillar 7)

Rust does not give determinism for free. A violation is a bug even if no desync
has been observed — a determinism bug is not a crash, it is two clients quietly
disagreeing about who won, half an hour in.

---

## The rules, and how each is enforced

| Rule | Enforcement |
|---|---|
| No `HashMap` / `HashSet` in simulation code | `diomano-sim` is `#![no_std]`, so they are not in scope at all. `clippy.toml` `disallowed-types` catches the `std`-linked crates. |
| No sort without a total order | The one ordering that matters (combat) is a stable counting sort over an id-indexed array, so no comparator exists. See `combat.md`. |
| Combat resolution order | `combat::pairs_resolve_in_ascending_id_order` and `stress_200_simultaneous_contacts_is_deterministic`. |
| Explicit overflow semantics | `overflow-checks = true` in **every** profile (workspace `Cargo.toml`), so debug and release agree bit-for-bit. A panic is a deterministic outcome; a silent wrap in release only is not. |
| No floats in simulation state | `clippy::float_arithmetic` denied crate-wide, allowed in exactly one module. See below. |
| No GPU compute in the simulation | The GPU never sees simulation state; it reads vertex buffers the CPU wrote. |
| One seeded PRNG for the sim | `hash::Rng`, a value type stored in the world with explicit `&mut self` — there is no global or thread-local instance to advance from a render callback. |
| Fixed neighbour iteration order | `seams::DIR_DX` / `DIR_DY`, N, E, S, W, everywhere. |
| Fixed tick pass order | `World::tick`, see `simulation.md`. |
| Animation never feeds back into state | The renderer takes `&Sim` and mutates nothing. |
| No wall-clock time in the simulation | `std::time::Instant` and `SystemTime` are in `disallowed-types`; the one legitimate use (the perf harness, which lives *outside* the sim) carries an explicit `#[expect]`. |
| Flow field and influence recompute only on fixed boundaries | Every 15 ticks, in `World::tick`. |

Run `just lint` (`cargo clippy --workspace --all-targets -- -D warnings`) to
check all of the lint-enforced ones.

### The float exception

§10 says "no floats in **simulation state**; `f32`/`f64` in render code only",
and §9.1 puts chunk meshing in Rust. Both are satisfied by keeping the only
float code in `mesh.rs`, behind a hard rule that the module is write-only with
respect to the world: it takes `&World` and fills its own buffers, so no float
it computes can reach a hashed field. `mesh::meshing_never_touches_the_world`
asserts it.

`clippy::float_arithmetic` is denied at the crate root and allowed exactly once,
at the top of `mesh.rs`, with that reasoning attached. A second `#[allow]`
appearing anywhere is the signal that this has broken down.

This is a **conflict between the prompt for this run and the HANDOFF**: the
prompt says "no `f32`/`f64` anywhere in `diomano-sim`", and the mandated layout
puts `mesh.rs` inside `diomano-sim`. Taken literally the two cannot both hold,
because meshing must emit float vertex buffers. The HANDOFF's wording wins, as
instructed, and the containment above is how.

### `N` is compile-time

The manifest's `n` is validated against the compiled `N` and a mismatch is a
parse error. This is a deviation from §5.4's implication that `n` is per-map
data, and it is a direct consequence of `no_std` with no allocation: every field
is a fixed-size array.

The alternative — making `N` runtime and allocating — would put a `Vec` in
`World`, which would break `World::boxed`'s zero-init and put allocator
addresses within reach of the simulation. Recompiling for a different `N` is
cheap; the class of bug avoided is not.

## State hash

`height`, `water`, `lava`, `material`, `influence`, `vegetation`, `fertility`,
`sediment` over **live cells only**, plus walker and settlement state, the two
hands, both magnets, mana, the tide, the outcome and the PRNG state. FNV-1a 64,
twenty lines we own — no dependency, and no chance of a version bump silently
changing the hash of a committed fixture.

Ghost cells are deliberately **not** hashed: they are a derived cache, and
hashing them would let a harmless copy-order difference read as a desync.
`world::ghost_cells_are_not_hashed` asserts it.

Dead walker slots hash as a fixed marker rather than being skipped, so slot
reuse cannot be confused with slot survival.

## The four checks

### 1. `determinism::same_seed_same_hash_10k_ticks`

Two independent worlds, 10,000 ticks each, identical hash sequences.

"In one process" is the load-bearing part: a `HashMap` seeded from `RandomState`
is stable *within* a process, so a cross-process comparison would pass while the
rule was being broken. It also asserts that more than half the hashes are
distinct — a world that never changes is trivially reproducible and proves
nothing — and that a different seed produces a different history.

`interleaved_worlds_do_not_contaminate_each_other` is the sharper version: two
worlds advanced tick-for-tick, compared every tick, then checked against a third
run in isolation.

### 2. `determinism::cross_build_hash_matches`

Replays the committed `fixtures/session.log` and compares against the committed
`fixtures/session.hashes`. This is the cross-*build* axis: the fixture was
produced by an earlier build, so a change that alters simulation behaviour fails
here even when it is perfectly self-consistent.

**Regenerating the fixture to make this pass is always a decision, never a fix.**
`just record` prints a reminder saying so.

### 3. `just verify`

The same comparison through the CLI, which is what a human runs.

### 4. `just verify-cross` — the one that matters

The browser replays `fixtures/session.log` headlessly in real Chromium, dumps
its hash sequence, and the script diffs it against the native run.

This is the single most valuable artifact of the project and the reason the
simulation is a separate Rust crate at all. If native and WASM disagree,
determinism is already broken and the netcode phase is dead on arrival — and it
cannot be retrofitted later.

It runs a real browser rather than the module under Node, because Node and the
browser are different embeddings and the browser is the one that ships. It exits
non-zero on any failure to *run* the check, not just on divergence: "could not
verify" is not "verified".

**Status: passing.** 80 state hashes over 2,400 ticks on `fixtures/session.log`,
plus 667 hashes over 20,000 ticks on each of the ten `fixtures/match-NN.log`
corpus matches, all identical between the native binary and headless Chromium.

## The corpus

`docs/HANDOFF.md` §6.3 asks for 10 recorded matches of ≥ 20,000 ticks each,
covering every verb at least 20 times and at least 200 combat resolutions,
replaying bit-identically native vs. headless browser. All four hold, and
`diomano-cli corpus --check-only` enforces all four. The combat count was zero
until the contact corridor connected the two spawns; the whole account —
including why flood and swamp force the corpus into profiles — is in
`netcode.md` rather than duplicated here.

## Diagnostic counters are not state

`World::census` counts combat resolutions, merges and applied verbs per verb, so
§6.3's coverage can be asserted rather than eyeballed. It is **excluded from the
state hash**, and `world::tests::the_census_is_not_hashed` pins that: a
diagnostic inside the hash would make every committed fixture a hostage of its own
instrumentation, and adding a counter would read as a desync.

Nothing in the simulation may *read* the census. Write-only from the simulation's
point of view is what keeps it from becoming state by accident.
