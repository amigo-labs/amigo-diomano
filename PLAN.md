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
cargo test --workspace                  # 155 tests
cargo run -p diomano-cli -- perf        # per-pass ms breakdown
cargo run -p diomano-cli -- replay fixtures/session.log --verify
just build-web && just dev
just verify-cross                       # native vs headless Chromium
just verify-corpus                      # §6.3 coverage over the 10-match corpus
just verify-match 00                    # one long match, native then Chromium
just verify-lockstep                    # 120 ms RTT, 2% loss, no desync
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

Added since, all passing:

- `combat::stress_200_friendly_contacts_is_deterministic` — TODO-8's own stress
  case, because merging changes walker-count dynamics and the §4.7 guarantee has
  to be re-established for friendly contact rather than inherited
- `combat::leader_on_magnet_takes_no_damage_but_still_deals_it`
- `combat::a_leader_absorbs_rather_than_being_absorbed`
- `world::tests::the_census_is_not_hashed`

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

---

## Since: the corpus, the combat rules, and Phase 7's first slice

### 13. The two combat rules the research left open ✅

- [x] TODO-7 — the leader is invincible on its own papal magnet. Incoming damage
      only; the leader still deals its strength, so the holy fire is a threat and
      not a bunker
- [x] TODO-8 — friendly walkers merge on contact, with the leader always the
      absorber and champions excluded entirely
- [x] Three defects found and fixed along the way, none of which a short fixture
      would have shown: a spawn/merge loop (**16,928 merges against two surviving
      walkers**), army collapse to a single capped walker, and `make_champion`
      compounding strength to **255** on repeated casts. `docs/specs/combat.md`
      and `docs/balance-research.md` carry the detail

### 14. The §6.3 fixture corpus — three criteria of four

- [x] Ten matches of 20,000 ticks, `fixtures/match-00..09`, 1.2 MB total
- [x] Every verb applied 20+ times across the corpus, asserted rather than
      eyeballed — a script change that stops issuing a verb fails the build
- [x] Each match replays bit-identically native vs. headless Chromium, run as a
      10-way CI matrix so the wall clock is one match rather than the sum of ten
- [x] `World::census` instrumentation, excluded from the state hash and pinned so
      by `the_census_is_not_hashed`
- [x] **200 combat resolutions — closed by §19's contact corridor.** It was a
      structural zero for as long as the spawns had no land route between them
      (opposite faces, no naval movement, ocean between); the causeway plus a
      rally window long enough to actually march put the corpus at 16,000+
      resolutions, and `verify-corpus` now enforces the criterion in full.
      Combat determinism is additionally covered by the two 100-run stress tests
- [x] Two properties of the *verbs*, found here and recorded: `VERB_FLOOD` is
      monotonic, so the 20 uses the criterion demands drown the planet and
      guarantee zero combat; and the shipped §5.4 manifest disables swamp, so
      "every verb 20 times" is unreachable on it however long a match runs. Hence
      two corpus profiles, `war` and `cataclysm`
- [x] A `u16` overflow in the input script, latent at 2,400 ticks and a panic at
      20,000 — caught by the overflow checks §10 requires in every profile

### 15. Phase 7, first slice ✅

- [x] `web/src/netcode/frame.ts` — the 8-byte command codec. Not a second wire
      format: `Command::encode`'s bit layout, written out in TypeScript
- [x] `web/src/netcode/lockstep.ts` — 6-tick input delay, 2-tick batching, hash
      exchange every 30 ticks, halt-on-mismatch with an input-log dump, never a
      resync
- [x] `web/src/netcode/loopback.ts` — seeded latency, jitter and loss, so a
      netcode failure is replayable instead of flaky
- [x] `just verify-lockstep` — 1,200 ticks at the DoD's 120 ms RTT and 2% loss
      without divergence; identical hashes across two different link schedules, so
      arrival order provably cannot reach the simulation; and an injected
      divergence **caught**, because a detector never seen to fire is a comment
- [x] A design decision forced by measurement: every packet carries the whole
      unsimulated input window. One dropped frame is a deadlock and not a hiccup —
      measured, dead at tick 20 — and repeating the window costs bytes rather than
      a 120 ms retransmit round trip, which §6.6's budget maths says is the right
      way round
- [ ] WebRTC, TURN, signalling, Durable Objects, keyframes, reconnect, and the
      "DO duration for a full match under 5 GB-s" measurement — **not started**,
      and none of them verifiable without a deployed Cloudflare environment

### 16. Static hosting on Cloudflare ✅

- [x] `wrangler.jsonc` — an **assets-only** Worker: `assets` block, no `main`, so
      files are served without a Worker invocation per request. Unknown paths get a
      real 404, because there is one route and no client-side router
- [x] **No Durable Object**, so §6.6's "the Lobby DO must not stay alive during a
      match" holds by construction rather than by vigilance. That is the reason this
      landed separately from signalling
- [x] **Cloudflare builds and deploys**, via the git integration that already
      exists — so **no API token in GitHub**. That connection authenticates
      Cloudflare→GitHub and needs nothing from us; deploying from Actions would have
      needed credentials in the opposite direction
- [x] `scripts/cloudflare-build.sh` — the price of the above. The Workers image has
      no Rust, so it installs the toolchain per build with no cargo cache, then
      builds wasm → wasm-opt → vite. Slower builds, no credentials, chosen knowingly
- [x] The script refuses to finish without `index.html` and `diomano.wasm` in
      `web/dist`: an assets-only Worker with no assets is a *successful* deploy of a
      blank site, which is worse than a failed build
- [x] `just cf-build` runs that exact script locally; `just deploy-check` validates
      the config with no credentials inside `just check`, which also gets the
      production `vite build` exercised on every pull request
- [x] Resolves the `Workers Builds` red check that had never once succeeded — it
      was failing because nothing in the repo was deployable
- [ ] **One honest gap:** the rustup-install branch cannot be exercised anywhere
      Rust already exists, i.e. every machine this project is otherwise built on.
      First Cloudflare build is the test; if the image blocks rustup, the fallback is
      a CI deploy with a token
- [ ] Setup, not a code change: point the Workers Builds **build command** at
      `bash ./scripts/cloudflare-build.sh`

### 17. The renderer, looked at on a screen ✅

The geometry pipeline was in good shape and the shading layer had never been
inspected against an actual frame. Built the client, drove it in headless
Chromium at four camera positions, and isolated causes by hiding layers and
patching uniforms in a live page.

- [x] **`uCameraPosition` was declared in three shaders and written by none.** It
      stayed at the origin, so `viewDir` was the inward radial everywhere: the
      terrain's rim term evaluated to 1.0 over the *whole* planet rather than at
      the limb — a flat blue-grey wash on every pixel of ground, which is why the
      world read as a featureless ball; water Fresnel saturated the same way and
      replaced 70% of the Beer–Lambert gradient with flat sky; and the atmosphere
      shell's rim came out **exactly zero**, so the §7.3 effect called "highest
      impact per line in the whole list" drew nothing at all — and with it the
      whole no-HUD tide telegraph, which only multiplies that rim
- [x] **Two sun vectors and a frozen cloud clock**, the same class of defect:
      `planet.ts` and `water.ts` each built private copies of values
      `atmosphere.ts` was advancing. Terrain's terminator stood still while the
      clouds turned; ground shadows sampled a frozen noise field while the shell
      scrolled — exactly the failure `CLOUD_NOISE_GLSL` is shared to prevent.
      Sharing the noise stopped the pattern drifting; nobody had shared the clock
- [x] `renderer/view.ts` now owns all four shared values and every material takes
      the uniform objects by reference, so the drift is unrepresentable rather
      than merely fixed
- [x] **Normals were view-space, lit by a world-space sun.** `normalMatrix` is
      built from the modelView matrix; the terminator and the steep-reads-as-rock
      band swung around as the camera orbited
- [x] **`vertexColors: true` with no `color` attribute** on the settlement and
      walker materials: `USE_COLOR` got defined, the attribute was unbound,
      `MeshLambertMaterial` has no `defaultAttributeValues`, so `vColor` collapsed
      to zero and **settlements and walkers rendered black** — visible as a black
      hexagon on every screenshot — while the tier-2 night lights added nothing
- [x] **The hand's fill sphere was z-rejected by its own container**: the palm is
      transparent and wrote depth, so §4.2's one diegetic readout was invisible
- [x] FXAA moved after `OutputPass` (three documents the requirement), and two
      DPR sizing bugs alongside it

**Camera.** §7.2's "horizon always visible" is arithmetically unreachable while
the camera looks at the planet's centre: the limb needs `d >= 2.61 R` at 45°, and
`MIN_DISTANCE` is 1.35 R where the angular radius is 47.8°. Even the 2.3 R default
had the globe cut off top and bottom.

- [x] The camera tilts toward the horizon as it comes in and widens from 45° to
      56°, so curvature is on screen at *every* distance with the close working
      distance kept. `camera.up` is the local tangent, which also removes the
      `lookAt` degeneracy the pitch clamp was guarding
- [x] Right-drag orbits *until a spiral arms gesture mode* — `verbs.md` always
      said "(no spiral)" and nothing implemented it, so every gesture spun the
      planet under a path being matched in screen space
- [x] The gesture light trail §8 requires. `gestures.armed` was exported with the
      comment "the caller draws the trail" and read by nobody
- [x] Wheel normalised by `deltaMode` (zoom was dead in Firefox), drag
      sensitivity scaled by distance, zoom to the pointer, near plane tracking
      the distance
- [x] Picking refined against the surface instead of the mean sphere, and
      recomputed per frame instead of only on `pointermove`

**Models.** A tree was `cellScale * 1.6` tall against a total relief of 2.4 cells
— two thirds of the tallest peak — on an unjittered lattice, sawing through the
limb from orbit.

- [x] Trees a third of a cell, several stems per cell instead of one giant one,
      hashed jitter and rotation, hashed colour variation, ambient raised so the
      shadow side is shadow rather than black
- [x] Settlements draw as a cluster whose *count* is the tier; walker size keyed
      to rank rather than to `strength` (which §4.7 lets reach 255); champions and
      leaders finally distinguishable
- [x] Walkers drawn at their true Q16.16 sub-cell position — it was being floored,
      directly under a comment claiming otherwise — with bilinear surface height
- [x] The papal magnet has a visual at all. `dio_magnet_active` and friends were
      declared and never called, for the game's only click-verb
- [x] The snowline moved into the altitude the terrain can reach: it was
      `smoothstep(0.055, 0.085)` against a maximum of 0.0576, so a tier-1 feature
      never appeared
- [x] `vegetation.sync` is gated on the tick changing and trees rebuild every 15
      ticks, instead of rebuilding ~7,700 instances every frame

**Mesher.** Two real artefacts, both found by looking:

- [x] **Chunk-border normals disagreed.** `build_normals` differenced `positions`,
      whose outer ring is the skirt duplicate, so a border vertex got a one-sided
      difference — forward on one chunk, backward on its neighbour. Now
      differenced from a corner grid that includes the ring outside the chunk, at
      no extra `corner_height` cost. `normals_agree_across_chunk_borders`, and it
      was confirmed to fail against the old code before being kept
- [x] **`SKIRT_DROP` is zero.** The visible hairline grid every 16 cells was the
      skirt, not the normals: both chunks drop their shared ring, so the pair cuts
      a V-groove along every border. No value works — hiding a stale neighbour
      needs at least one terrace, 0.00128, and 0.0008 was already visible. What
      closes the window is `update` dirtying both sides, which it does
- [ ] The twelve cube edges keep one-sided normals: the corner outside a face
      needs a two-deep ghost ring and the ring is one deep. Documented, not fixed

**Not done, and deliberately separate** — these are new content rather than
repairs to shipped features, and lava needs a new vertex-attribute channel
through the mesher, which is a wasm ABI change with its own tests:

- [x] Lava has no visual. `sim.lava` is mapped and read by no renderer file, so a
      volcano shows ash afterwards and never hot lava — **done in §18**
- [x] No verb effects at all — flood, volcano, swamp, earthquake, armageddon have
      no particles, decals or shake; feedback is audio plus the next re-mesh —
      **done in §18**
- [x] `fertility` and `sediment` are mapped and unused; §7.4 asks for all five —
      **done in §18**

### 18. Lava, the missing attributes, and the verb effects ✅

The three items above, done as their own change because they are new content
rather than repairs, and because lava needed a wasm ABI change.

- [x] **`attribs2`: lava, fertility, sediment.** `attribs` was full, so §7.4's
      "write them as vertex attributes" was three-fifths done. Lava is drawn
      emissively — over the shaded result, not multiplied by the sun, because it
      *is* the light source — on a depth ramp whose core sits above the bloom
      threshold, so a flow glows into the air around it
- [x] Lava is the **maximum** of the four cells at a corner, not the mean: it is a
      fluid front, and averaging fades the edge over a cell and a half when what
      the player has to read is where the front is
- [x] **Everything in the vertex buffers is now in `chunk_content_hash`.** Lava is
      what made this load-bearing — it moves every tick over ground that does not,
      so its chunk would never have been re-meshed and the attribute would have
      gone stale on the first frame.
      `lava_reaches_the_vertex_buffer_and_dirties_its_chunk` asserts both
      directions, including that a cooled flow stops glowing
- [x] **A verb-event ring**, written where the census already counts verbs and past
      the same gating. So a power refused on cost throws no sparks, and the
      *opponent's* casts become visible — which a click-driven effect system cannot
      do, since a client sees its own commands and never theirs. Instrumentation,
      excluded from the hash, covered by `the_census_is_not_hashed`
- [x] One instanced draw call for every particle of every effect, plus camera shake
      applied to the eye and not the target, so the horizon stays level
- [x] Two things that had to be right: a burst starts spread across the brush
      radius, or forty coincident additive sprites saturate to a white blob; and
      per-particle colour is a fraction of the intended brightness, or every effect
      looks identical
- [x] Verified in the browser rather than assumed: the AI's own volcano was caught
      firing (verb 6 in the ring, particles alive), and a cast earthquake spent
      exactly its 120 mana and emitted its 38 particles
- [ ] Raise, lower, magnet and set-hand deliberately have no effect: their feedback
      is the terrain and the hand, and sparks on every terrace step would be
      constant noise

Measured: meshing is **1.00 ms/tick at 15.3 chunks**, up from 0.60. The increase is
the corner grid the §17 normal fix needs plus the new attribute channel. Two
candidate savings were measured and **rejected** — reading the scalar height back
from the corner grid, and moving the per-chunk scratch off the stack — because
neither moved the number. The cost is the two vertex passes.

### 19. Making it a game: contact, an opponent, an ending, a front door ✅

Everything above built a simulation; this pass made it playable. The findings and
the fixes, in causal order:

- [x] **The contact corridor.** The two peoples could never meet: antipodal
      spawns, no naval movement, ocean between — the §14 gap was really a
      game-design hole. `settlements::carve_contact_corridor` now carves a
      3-wide great-circle causeway between the spawns at init: **rock**, because
      a sand ridge 400 units above the sea floor obeys the angle of repose and
      dissolved within a few hundred ticks (measured); height 40, above the calm
      sea and `FLOOD_CAP` but below every wave peak, so the tide closes the road
      at every impact and returns it at every recovery — §5.5's contested
      causeway as literal geography. Habitable, so holding the road pays.
      `spawns_are_connected_at_tick_zero` (3 terrains × 4 seeds) is the
      load-bearing test; `the_causeway_survives_the_early_game` pins it against
      physics and tide
- [x] **Flow-field fallback.** An active magnet was the *sole* BFS seed, so a
      magnet across water froze the whole army for the rest of the match. Pass
      two now seeds the unreached remainder from the home targets at
      `FALLBACK_BASE` — a misplaced magnet means "the army regroups", never
      "the army is bricked"
- [x] **The opponent fights back.** After one pass of the six-lesson curriculum
      (kept verbatim), `ai.rs` switches to a war table: grow the economy, magnet
      onto the enemy's strongest settlement, earthquake it when affordable past
      a mana reserve, wall up at tide telegraphs. Two self-sabotages found on
      the way: lesson 4 dug its channel straight through the corridor's northern
      approach (moved south), and a volcano strike made the AI's *own* magnet
      cell impassable, recalling its army mid-siege (strike is earthquake-only).
      Traced end state: the AI marches the causeway and wins by sudden death
      against a non-defending script in under two minutes
- [x] **Matches end now.** `World::tick` freezes on a decided outcome (commands
      ignored, hash cadence kept, `cfg.endless` opts the corpus out), the client
      finally reads `dio_outcome`/`dio_score`, plays a procedural sting, drifts
      the camera over the final tableau, and shows an end card with the per-wave
      score and two restarts (same seed / new seed) via in-place `dio_init` —
      verified re-callable, plus `planet/water.refreshAll()` because the dirty
      flags are consumed before the client can see them
- [x] **A front door.** Title card with the premise and the controls table
      (German, per Phase 9), click-to-start doubling as the audio unlock, sim
      gated behind it, then a one-time camera tour: two seconds on the opponent's
      spawn — the other god exists and its casts are audible now — then an eased
      pan home. Any input cancels it
- [x] **Input repairs.** The magnet click test compared a *residue* of the drag
      accumulator, so nearly every sculpt ended by teleporting the population
      (now: 5 px slop from the down point + 400 ms); fast drags lost everything
      past one step per tick (now: queued and drained at the release target);
      the modifier ring stuck after release; the mana glow saturated at 8% of
      its range (now: sqrt anchored at the armageddon price, with a pulse when
      the big one is affordable); pickup charges were entirely invisible (now:
      gold motes orbiting the hand)
- [x] **Truthful cast feedback.** The old confirm played on gesture
      *recognition* — including for swamp, which the manifest disables. Casts
      now confirm from the applied-verb ring (the sim's own record, written past
      cost/enabled gating), a cast whose event never arrives gets an audible
      refusal plus a hand flash, the opponent's casts play quietly, and
      raise/lower finally makes a sound (a leaky-integrator grind, not a
      machine gun)
- [x] **Balance.** Armageddon 4000 → 2500 (a whole match's income could not buy
      the stalemate breaker; `armageddon_is_earnable_in_a_match` pins the
      constants henceforth), flood 400 → 600 with `FLOOD_CAP` at two terraces
      (uncapped it drowned the planet in 20 casts — and at four terraces two
      casts amputated the causeway for good), swamp stays disabled
- [x] **Honest tabs.** `visibilitychange` pauses the loop and audio instead of
      silently deleting up to a minute of simulation through the catch-up cap
- [x] Corpus regenerated and the §6.3 combat criterion **enforced**: 16,598
      resolutions over ten matches, rally windows six cycles long (walkers cross
      at ONE/16 cells per tick — a rally that rotates faster than an army can
      march is a yo-yo nobody reaches, measured as exactly zero combat), matches
      8–9 running the scripted opponent for cross-build coverage of both its
      phases
- [x] `web/tools/screenshot.mjs` — headless smoke test of the shell UI: title,
      intro pan, gameplay, forced ending, end card, restart, all screenshotted
      and the restart asserted to produce a running match

### 20. The spawn pedestal, an honest end card, and a menu instead of gestures ✅

Two problems reported from play, both fixed at the root:

- [x] **"Niederlage" seconds after starting.** The `074e3dd` terrain (archipelago
      bias 150 → 350) had moved both spawns into deep ocean, leaving each god's
      forced 5×5 platform a ~670-unit soil mesa — their *entire* territory and
      their *only* influence source. The scripted opponent's first earthquake
      converted the soil to ash, the ash obeyed the angle of repose against the
      abyss, the whole spawn avalanched into the sea, and `check_sudden_death`
      ended the match with no player mistake anywhere. Worse, an *idle* match
      died on its own: dry-rot turned the platform's soil to sand at ~tick 8,300
      (the player always first — the generator dealt them less fertility), and
      the sand slid the same way. And on pangaea the fixed height 320 dug the
      platform into a *pit* wherever real mountains stood around a spawn, so
      material slid *onto* it and razed the seed settlement inside two seconds.
      The fix is one mechanism, `carve_spawn_pedestal`: the platform height is
      surveyed (`spawn_platform_height` — at least the documented 320, always
      two terraces above anything within 12 cells), and a 3-wide flat **rock**
      shelf rings it exactly one terrace down. `TERRACE <= REPOSE_ASH` (pinned
      by a compile-time assert) means quake-ash and rot-sand now *rest on the
      shelf* instead of avalanching; rock neither burns nor rots nor slides; and
      the shelf auto-founds satellite huts, so sudden death again means "lost
      all ground", never "lost one cast". Seed fertility is a fixed 200 (was
      `max(120)`), killing the rot asymmetry. Five regression tests pin it —
      opening war, idle rot, one-quake survival, shelf satellites, and all
      3 terrains × 4 seeds — plus minimum-match-length asserts in
      `screenshot.mjs` and `diomano-cli trace` (no outcome before the first
      wave peak, tick 1,275). The AI legitimately beating a *never-acting*
      player by siege at ~tick 4,200 remains, per §5.5 and the playtest note
      below. Fixture, corpus and cross-build hashes regenerated (seeding
      changes state from tick 0)
- [x] **The end card says why.** Sudden death and the wave-score decision are
      different stories; the card now tells the right one (derived from
      `dio_tide_phase` — `decide_match` fires exactly at `TIDE_DONE`), naming
      which people lost all influence and during which wave
- [x] **The radial power menu replaces the gestures** (user decision; §8
      narrowed accordingly). Right-click opens a ring of the manifest's enabled
      powers at the cursor — costs live from the new `dio_power_cost`/
      `dio_power_enabled` exports, unaffordable slices greyed against live
      mana, free-use charges shown, armageddon behind a confirming second
      click — and casts at the cell snapshotted at open time. Right-drag stays
      the orbit (same 5 px/400 ms click test the magnet uses). `gestures.ts`
      and the stroke trail are gone, and with them the main↔gestures import
      cycle; `VERB`/`MOD`/`POWER` moved to `verbs.ts`. The hand's brush-preview
      ring now mirrors `brush_radius` exactly (thrown base 2; extreme over
      increased), and its armageddon pulse reads the manifest price instead of
      a mirrored 2500

- [x] **A legible power menu.** Opened over a sunlit coast, or over the hand's
      own cream palm and pale-gold footprint ring, the menu was unreadable:
      a transparent backdrop, 13px labels on 78%-opaque boxes, and
      `opacity: 0.38` on unaffordable slices, which took the box down with the
      text so the price was the first thing to vanish. The backdrop now carries a
      scrim anchored on the ring, the hand is hidden while the menu is open (its
      target cell is already snapshotted), labels are 500-weight 15px, disabled
      slices keep their contrast and turn the price muted red, and the ring grew
      120 → 168px because six legible boxes on a 120px ring overlapped. The hub
      says the mana total, so the prices have something to be compared against
- [x] **A world that is not a grid.** Three unrelated causes, of which only the
      first was where anyone would look:
      - `attribs[0]` carried a material **id**, and the GPU interpolates vertex
        attributes: between rock (0) and soil (2) the value passes through 1,
        which is sand, and the shader thresholded it. Every rock/soil boundary
        grew a one-cell sand stripe with two hard, cell-aligned edges.
        `attribs3` carries **weights** instead, noise-sharpened so the boundary
        follows the noise field and not the cell grid
      - `carve_spawn_pedestal` used Chebyshev rings — a square mesa in a square
        band in three square terraces, the most artificial thing in frame. Now a
        euclidean radius with a coherent outward-only fringe, and a sloped apron
      - the noise showed its lattice at cell scale. The per-octave swizzles are
        isometries, and every isometry of the cubic lattice keeps axis planes
        axis-parallel; at shift 8 that lattice is two cells wide. Each octave is
        now sheared, and a second domain warp at shift 9 bends the fine octaves
        the shift-11 warp could only translate
      Plus a second Laplacian pass at half weight, so a terrace stops reading as
      a terrace without dissolving §7.1's crisp-cliffs-soft-dunes contrast.
      Fixtures, corpus and cross-build hashes regenerated (the terrain moved);
      land fractions barely shifted, so no profile bias needed retuning
- [x] **§8's "no HUD" is now a deviation, deliberately** (user decision). Played
      through, the match could not answer four questions it constantly poses: how
      much mana, which wave of seven, who is winning, and what just happened over
      there. The palm's glow answers the first only as a feeling; §7.4's "the
      planet is the scoreboard" does not survive a camera pointed at your own
      coastline; and `effects.ts` draws applied verbs *in the world*, so a power
      landing off screen or on the far side was indistinguishable from one that
      never fired — the exact problem it exists to fix, solved for half a sphere.

      `hud.ts` answers the first three: a panel with mana, wave and tide phase,
      and a territory bar sampled from `influence`, plus a banner on every tide
      phase change and three coaching lines that each retire the moment the
      player does the thing. Nothing in it is interactive, nothing is a resource
      bar to manage, and it hides for the title and end cards — what §8 was
      protecting is a screen that is mostly planet and verbs you feel rather
      than read, and that is intact
- [ ] **KNOWN GAP: "what just happened, over there?"** still unanswered.
      Screen-edge DOM markers for applied verbs were built and then withdrawn,
      because they could not be shown to work: the element sat in the document
      with the right rect, `visibility: visible`, `opacity: 1` and an opaque
      background, and did not appear in a capture — and `waitForSelector` would
      match one while the very next round-trip found it gone, which no
      2.6 s lifetime explains. Node pooling, restricting them to the frame edge,
      and casting on the far side each changed nothing; one early capture *did*
      show one, which is worse than none, because the mechanism can paint and
      nothing identified decides when. The next attempt should draw the
      indicator in the 3D scene, where `effects.ts` already has the instancing
      and the projection, instead of in a DOM layer over a WebGL canvas
- [ ] **KNOWN DEFECT: the black ring around a spawn pedestal.** Two cells wide,
      exactly `rgb(0, 0, 0)`, and pixel-identical on main, so it predates all of
      the above. The terrain geometry is present (confirmed in wireframe, and
      `side: DoubleSide` changes nothing), and the fragment output is a hard zero
      for inputs that are dry, flat, pure rock three hundred units above sea
      level. Something in the terrain shader produces a NaN or a zero for that
      case. Gating the abyssal-floor colour on altitude — which was a real bug
      of its own, dry rock painted as sea bed — does not touch it
- [x] **The volume is settable.** `master.gain` was a hard-coded 0.5 with nothing
      wired to it, on a game with a procedural surf bed running the whole match.
      A slider on the title card (whose pointer events stop before the card can
      read them as "start the match"), `+` / `-` / `M` in the match with the
      banner as feedback, and both values remembered in `localStorage` behind a
      try/catch, because storage that throws must not stop a game from starting

## Next

Phase 7's remaining half is transport and signalling, and it is gated on
infrastructure rather than on code: `Lockstep` drives a `Transport` interface and
WebRTC is a drop-in for it. Static hosting is now in place (§16) and deliberately
brought no Durable Object with it, so the §6.6 budget rule is still unviolated and
still un-designed — design it first, because the Lobby DO must not stay alive during
a match, that is failure mode 5, and it will never show up in testing with two
people and one match.

Playtest balance is the other open item, now that matches actually resolve: the
war-phase AI beats a passive player by sudden death in a couple of minutes, the
causeway invites a dig-and-turtle counter whose price (your own expansion) is
asserted nowhere, and the §5.5 target of "roughly 15 minutes" per match has not
been measured against a human. Phase 8's playtesting can finally begin, because
there is finally a game to playtest.

The first of those three is now designed rather than only observed:
`docs/specs/pacing.md` carries the five rule changes that stop a passive player
losing to the marching army — a siege that subdues instead of razing, an
influence floor at the spawn pedestal, a 90-second grace window before sudden
death, sudden death armed only by the first wave, and an opponent whose war
phase waits for that same wave. Not implemented; the fixtures move when it is.
