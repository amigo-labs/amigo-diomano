# PLAN

Working plan for the first implementation pass. `docs/HANDOFF.md` is the
specification and wins every disagreement with this file; `docs/specs/*.md`
carry the implementation contract and the values measured since.

**Scope of this run:** Phases 0–6 of HANDOFF §12, plus the tide cycle from Phase
8 and a scripted opponent.

**Explicitly not in this run:** WebRTC, lockstep, command frames on a wire,
input delay, Durable Objects, Cloudflare anything, keyframes, reconnect,
spectator, replay UI, renderer tier 3, menus, settings screens, tutorials, lobby
UI, external assets of any kind.

---

## Build order

Each step ended with its tests passing before the next began.

### 1. Workspace, toolchain, CI, `justfile` ✅

- [x] Cargo workspace: `diomano-sim` (`no_std`), `diomano-wasm` (cdylib),
      `diomano-cli` (native)
- [x] Bun workspace, Vite, TypeScript strict with `noUncheckedIndexedAccess` and
      `verbatimModuleSyntax`, Biome (2-space, 100 char, double quotes)
- [x] `just check` = `cargo test` + `cargo clippy -- -D warnings` +
      `biome check` + `tsc --noEmit`
- [x] Determinism lint set: `clippy::float_arithmetic` denied crate-wide,
      `disallowed-types` for hash containers and clocks, `overflow-checks` in
      **every** profile
- [x] GitHub Actions running exactly `just check`, `just verify` and
      `just verify-cross`

### 2. `fixed.rs` and `hash.rs` ✅

- [x] Q16.16 with a 64-bit intermediate, saturating rather than wrapping
- [x] FNV-1a 64 and a `SplitMix64` sim PRNG
- [x] Property tests over ~1.5M multiply pairs plus every edge case, on a fixed
      seed — a property test that is not itself reproducible cannot guard a
      determinism invariant

### 3. `world.rs` and `seams.rs` — **stop and prove the seam table** ✅

- [x] Face indexing, stride, ghost border layout, units
- [x] 24-entry seam table, **derived at compile time from the face bases** rather
      than typed by hand
- [x] Ghost border copy as one gather over precomputed tables
- [x] `seams::closed_loop_all_24_entry_points` — 6 faces × 4 directions × 64
      offsets, `4N` steps each, closing on the same cell *and* heading
- [x] `seams::neighbour_is_involutive` — every cell, every direction

  > The prompt's literal form, `neighbour(neighbour(c, dir), opposite(dir)) == c`,
  > is **false on a correct cubed sphere** and would fail this implementation.
  > See "Conflicts" below.

### 4. Raise/lower with matter conservation, plus `diomano-cli` ✅

- [x] `deform` with a hand budget: full hand cannot dig, empty hand cannot build
- [x] State hash over live cells only
- [x] `diomano-cli hash` — tick from a seed, print a hash per tick
- [x] `diomano-cli record` / `replay --verify`

### 4b. Balance research (Phase 2 research task) ✅

- [x] `docs/balance-research.md`, from the sources §2 names
- [x] **Finding: the numbers are not published.** Both manuals and the guides
      describe the systems qualitatively; popre.net's numeric material is about
      Populous: The Beginning, which §1 rejects as a reference. So every numeric
      `[START]` has to be settled by playtest rather than by citation — Phase 8
      is the *only* source for them, not a confirmation step.
- [x] Thirteen **mechanical** findings recorded, several of which validate
      design decisions (5×5 was the original's minimum settlement; mana really
      was population-derived, which is what §4.6 diverges from)
- [x] Six numeric gaps and two implementation gaps marked `TODO` with the
      blocking input named for each

### 5. Perf harness, and choose `N` ✅

- [x] `diomano-cli perf` — per-pass ms breakdown against the 12 ms budget
- [x] Measured: **1.51 ms/tick at N = 64**, 12.6% of budget
- [x] **N stays at 64**, with the measurement and the reasoning recorded in
      `docs/specs/world.md`. The `[START]` guess and the measured choice
      coincide; what changed is that the cost is now a number.
- [ ] ⚠️ **Unverified:** the §7.6 reference floor. No GPU to throttle here.

### 6. `web/`, WASM loading, zero-copy views, `mesh.rs`, planet, camera ✅

- [x] `WebAssembly.instantiateStreaming`, no `wasm-bindgen`, no glue JS
- [x] Typed-array views over `memory.buffer`; memory pre-allocated and never
      grown (no allocator is linked into the wasm build at all)
- [x] Dual grid + material-weighted Laplacian + skirts + ghost-derived seam
      vertices, chunked 16×16, dirty-chunk re-mesh
- [x] Tangent-adjusted cube-to-sphere, exact at face edges
- [x] Orbit camera on a spherical shell, horizon always visible
- [x] **Milestone: a planet you can orbit whose terrain you can raise and lower**

### 7. `flowfield.rs`, `walkers.rs`, `settlements.rs` ✅

- [x] Integer BFS flow field, fixed neighbour order, 15-tick boundary
- [x] Influence projection as a monotone bucket BFS, zero-sum combine
- [x] Walkers with seam crossing that carries the sub-cell offset
- [x] Plateau detection, tiers, `settlements::plateau_5x5_produces_house`
- [x] Mana from held habitable territory
- [x] Papal magnet, leader, and "never leave own influence without one"

### 8. `water.rs`, `materials.rs` ✅

- [x] Checkerboard water and lava, with exact conservation across seams
- [x] Global sea level as a boundary condition
- [x] Full interaction matrix, **table-driven** — `INTERACTIONS` is the spec's
      rows in the spec's order; the evaluator knows nothing about lava
- [x] Granular movement with angle of repose
- [x] `water::settles_without_oscillation`
- [x] `materials::lava_plus_water_yields_rock`
- [x] **The forest-gap channeling of §4.3 observed with no special-case code**

### 9. `combat.rs` and the stress test ✅

- [x] Resolution ordering exactly per §4.7, by construction rather than by sort
- [x] `combat::stress_200_simultaneous_contacts_is_deterministic` — 100 runs
- [x] Gradual settlement decay with a bounded reaction window
- [x] Champion, which finds the enemy by following the opponent's flow field

### 10. `powers.rs`, map manifest, `hand.ts`, `gestures.ts`, no HUD ✅

- [x] Hand-written TOML subset parser with line numbers on errors
- [x] Earthquake, swamp, volcano, flood, armageddon, champion, set-hand
- [x] Thrown vs. poured, increased/extreme
- [x] Gestures sampled on a fixed 60 Hz timer, never per frame
- [x] No HUD anywhere; matter, mana and reach are all diegetic
- [x] One-shot pickups on neutral ground, granting one free use of a power

### 11. `tide.rs` and `ai.rs` ✅

- [x] Telegraph → impact → recovery → escalate, per wave
- [x] **Telegraph readable with no UI:** the sea draws back off every shore
      before the surge, and the atmosphere rim reddens and thickens
- [x] Per-wave scoring at wave peak, sudden death on zero influence
- [x] Scripted opponent that emits only ordinary commands, one lesson at a time

### 12. Renderer tiers 1 and 2, then procedural audio ✅

- [x] Tier 1 complete
- [x] Tier 2: instanced vegetation, water ripple, sun glitter
- [x] Tier 2: night-side settlement lights, cloud shell with matching ground
      shadows (one shared noise function, not two)
- [ ] Tier 2: single sun shadow map — **not implemented**, and the right thing
      to leave: cloud shadows cover the large-scale case, and terrain
      self-shadowing is exactly what will or will not fit on the §7.6 floor
- [x] Draw calls: **7 at tier 2**, measured, against a `[START]` ceiling of 150
- [x] Procedural audio: surf bed tracking real water movement, verb one-shots

---

## Machine-checkable acceptance

All run, all green:

```
just check                              # clean, zero warnings
cargo test --workspace                  # 142 tests
cargo run -p diomano-cli -- perf        # per-pass ms breakdown
cargo run -p diomano-cli -- replay fixtures/session.log --verify
just build-web && just dev
just verify-cross                       # native vs headless Chromium
```

Required tests, by name — all present and passing:

- `seams::closed_loop_all_24_entry_points`
- `seams::neighbour_is_involutive`
- `determinism::same_seed_same_hash_10k_ticks`
- `determinism::cross_build_hash_matches`
- `water::settles_without_oscillation`
- `combat::stress_200_simultaneous_contacts_is_deterministic`
- `materials::lava_plus_water_yields_rock`
- `settlements::plateau_5x5_produces_house`

---

## Conflicts and decisions needing a human

Recorded rather than resolved silently. See the run summary for the full list.

1. **`neighbour_is_involutive` as literally specified is false.** On a cube the
   heading rotates across half the seams, so the return step must use
   `opposite(d')` — the reverse of the heading *in the destination frame* — not
   `opposite(d)`. The test exists under the required name and asserts the
   correct law. This is a property of cubes, not a choice.
2. **"No floats anywhere in `diomano-sim`" vs. `mesh.rs` living in
   `diomano-sim`.** Meshing must emit float vertex buffers. HANDOFF §10's
   wording ("no floats in simulation *state*") is followed, with containment
   documented in `docs/specs/determinism.md`.
3. **`N` is compile-time, so a manifest's `n` is validated, not applied.** A
   consequence of `no_std` with no allocation. `docs/specs/world.md`.
4. **Two rows of §4.4 reordered** so lava burns before it cools, and
   `water -= 48` reads as "the water it met" rather than "its own depth".
   `docs/specs/simulation.md`.
5. **The 8-byte command packing had to be invented**; §6.2's seven fields total
   12 bytes. `docs/specs/verbs.md`.
6. **§7.6's 30 fps on integrated graphics is unverified.** No throttleable GPU
   here. Marked unverified rather than reported from strong hardware.
7. **The originals' balance numbers do not exist in public sources.**
   `docs/balance-research.md`. §2 assumes they can be researched; for mechanics
   that is true and productive, for quantities it is not.

## Next

Phase 7 (netcode) is the next phase and its prerequisite is met: native and
browser agree bit-for-bit. Before starting it, raise the fixture corpus toward
the §6.3 criterion — the harness is complete, only the corpus is small.

Two decisions are waiting in `docs/balance-research.md`, both found while
researching and both touching combat: whether the leader should be invincible
while standing on the papal magnet (the original's rule, and it makes a forward
magnet defensible rather than suicidal), and whether walkers should merge into
one stronger walker on contact (the original's rule, and without it the manual's
own advice — gather at the magnet, combine for strength — has no analogue here).
Both are recorded rather than implemented, because both change the site §13
names as most likely to pass casual testing while being wrong.
