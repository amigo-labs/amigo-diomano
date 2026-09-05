# Multiplayer and netcode

Split from `docs/HANDOFF.md` §6 (Phase 0).

> **Partly implemented.** The lockstep loop, the command-frame codec and a
> latency/loss transport exist and are tested (`web/src/netcode/`, `just
> verify-lockstep`), and the client is deployed to Cloudflare as static assets
> (`wrangler.jsonc`). WebRTC, TURN, signalling, Durable Objects, keyframes and
> reconnect do **not** exist — a half-built netcode layer is worse than none, and
> the DOs in particular should not appear until §6.6's "the Lobby DO must not stay
> alive during a match" is designed in rather than checked afterwards.
>
> Precisely what is done, and what is not, is marked per section below.

---

## What this run already guarantees

1. **The simulation advances by `tick(commands: &[Command])` and nothing else.**
   There is no other entry point into world state. Netcode changes where that
   slice comes from; it changes nothing about what happens to it.
2. **Commands are already an 8-byte wire format.** `Command::encode` /
   `decode`, with a documented bit layout — see `verbs.md`.
3. **Commands are buffered, not applied on arrival.** The wasm shell queues into
   a `CommandBuf` and `World::tick` applies it at pass 2, so input timing cannot
   couple into the result.
4. **State hashing every 30 ticks is implemented and exercised.**
5. **Native and browser builds agree bit-for-bit.** `just verify-cross`, passing
   over 2,400 ticks. This is the prerequisite; without it lockstep is not worth
   starting.

## Model

Deterministic lockstep. Only inputs cross the wire; all state is derived.
Bandwidth is independent of world size, destructibility and walker count.

**Implemented:** `web/src/netcode/lockstep.ts`. A tick is simulated only once
every peer's input for it is known — never predicted, never rolled back, never
resynced.

## Command frames — implemented

Packed to 8 bytes. Every tick both clients exchange a frame, empty frames
included, so a silent peer is distinguishable from a stalled one.

**Input delay: 6 ticks (200 ms)** `[START]`. Generous by action-game standards
and invisible in this genre — spend the latency budget here rather than risking
stalls. This is pillar 2 in practice: indirect control *is* the latency
strategy, which is why the genre was chosen.

Gesture recognition runs entirely client-side; only the result enters the
command stream. It already samples on a fixed timer rather than per frame, which
is the half of §6.2 that this run did implement.

`web/src/netcode/frame.ts` is the codec. It is not a second wire format: it is
`Command::encode`'s bit layout, the one documented above, written out in
TypeScript. Two encoders for one format is a desync waiting to happen, which is
why the roundtrip is asserted rather than assumed.

### Every packet carries every frame the peer might still need

Not in §6 and it has to be, because lockstep and packet loss interact badly:
the loop cannot pass a tick whose input it lacks, so **one dropped frame is a
deadlock, not a hiccup.** Measured: a match over a 2% loss link stopped dead at
tick 20 with nothing to retransmit it.

The conventional answer is a reliable ordered DataChannel and letting SCTP
retransmit. This repeats the window in the packet instead, trading bytes for
latency — a retransmit costs a whole round trip, 120 ms of the 200 ms input-delay
budget, whereas the entire window is `WINDOW_FRAMES` (14) empty frames, 112
bytes, of the same order as the ~100 bytes of framing every packet already pays
for. The budget maths below is what makes that trade obviously right.

The window runs from `now - MAX_PEER_LAG_TICKS` to `now + INPUT_DELAY_TICKS`.
The lower bound is the part that has been wrong twice. A fixed tail of history
was too short for the opening burst — tick 0 was evicted before it was ever sent
and the match deadlocked on its own first tick. Anchoring the window at the
sender's *own* tick then looked right and was not: we simulate tick T with the
*peer's* frame T, and the peer still needs ours. It can be up to
`INPUT_DELAY_TICKS + 1` ticks behind (it must have published through `now - 1`
for us to be at `now`), so once every packet carrying our frame T was lost — at
`TICKS_PER_PACKET = 2` that is three or four packets, not seven — the peer stalled
on T for good while we ran ahead, evicted T, and then stalled ourselves with a
window that no longer held the one frame that mattered. `verify-lockstep` now
loses every copy of one frame on purpose and demands that the match goes on.

Two further rules fall out of the same analysis. A frame is immutable from its
first transmission, because the receiver keeps the first copy it sees, so
`Lockstep.issue` never schedules into a frame already published — during a stall
the tick counter stands still while the publish horizon has moved on, and a
command issued then used to be applied on one peer only. And `Lockstep.step`
resends the window while it stalls: `publish` only sends when the tick moves,
which is exactly when nothing needs sending.

Correlated loss beyond the window — every copy of a frame lost for as long as
the window carries it — is still not a guarantee. The answer there remains the
stall path: `Lockstep.step` reports, waits and resends, and never invents input.

## Desync detection — implemented

Hash every 30 ticks; on mismatch halt immediately, dump both states plus the
input log, and do not attempt to resync. `Lockstep.compare` is terminal by
design: a resync would paper over the bug that caused the divergence, and the bug
is the only thing that matters.

A hash claim for a tick the receiver has not reached yet is **kept**, not
dropped. At 120 ms RTT a peer is routinely a few ticks ahead, so discarding early
claims would silently switch off desync detection exactly under load — which is
where a desync is most likely.

`just verify-lockstep` runs two wasm instances through the layer at the Phase 7
DoD's conditions (120 ms RTT, 2% loss, 30 ms jitter) and checks three things:
1,200 ticks without divergence; identical hashes across two different link
schedules, so arrival order provably cannot reach the simulation; and that an
injected divergence **is caught** — a detector never seen to fire is a comment.

### The §6.3 acceptance criterion

`[START]`: 10 recorded matches of ≥ 20,000 ticks each, covering every verb at
least 20 times and at least 200 combat resolutions, replaying bit-identically
native vs. headless browser.

**Status: all four met.** `fixtures/match-00..09` are ten matches of 20,000
ticks; `just verify-match N` replays each natively *and* in headless Chromium, as
a 10-way CI matrix so the wall clock is one match rather than ten. Every verb
clears 20 uses and the corpus records thousands of combat resolutions
(`just verify-corpus` enforces all of it).

**The combat count was zero for a long time, and the fix was geography, not
scripting.** The cause was structural: `seed_starting_positions` places the two
players on opposite faces, diomano has no naval movement, and on mostly-ocean
terrain there was no land route between the two homes — the flow-field BFS never
reached the far side, and both armies sat on their spawns for entire matches.
What closed it is the **contact corridor** (`settlements::carve_contact_corridor`):
a low rock causeway carved between the spawns at init — its crest wanders
inside the `[CAUSEWAY_CREST_MIN, CAUSEWAY_CREST_MAX]` band (36–45), above the
calm sea and the flood cap, below every wave peak — so it exists on every
terrain and seed, floods at every tide impact and reopens at every recovery.
The jitter is cosmetic geography (a ridge, not a wall); the spine path itself
is untouched and `corridor_cell` is still a pure function of the walk index. The corpus script rallies both magnets
on `corridor_cell(CORRIDOR_STEPS / 2)` in six-cycle windows — the window length
matters, because walkers cross at ONE/16 cells per tick and a rally that rotates
faster than an army can march is a yo-yo nobody ever reaches.

Combat determinism is additionally covered natively:
`combat::stress_200_simultaneous_contacts_is_deterministic` (200 simultaneous
contacts, 100 runs) and `stress_200_friendly_contacts_is_deterministic`.

### Two things the criterion cannot ask of one match

Found while building the corpus, and worth recording because both are properties
of the verbs rather than of the harness:

1. **`VERB_FLOOD` is monotonic.** It raises `sea_base` and nothing ever lowers
   it. Uncapped, twenty floods — the minimum the criterion asks for — left the
   planet under water, which drowned every route and guaranteed zero combat;
   `powers::FLOOD_CAP` now bounds the rise at two terraces, below the contact
   corridor, so flooding pressures the coasts without ever amputating the road.
   The corpus is still split — `war` matches that stay pristine, `cataclysm`
   matches that issue flood and armageddon, and two `ai-war` matches that give
   the scripted opponent's both phases long cross-build coverage. Counts are met
   across the corpus, per-match numbers all printed.
2. **The shipped §5.4 manifest disables swamp.** On that mask `VERB_SWAMP` is
   inert and "every verb at least 20 times" is unreachable no matter how long a
   match runs. The corpus therefore enables all eight powers and zeroes their
   costs, and `fixtures/session.log` stays on the shipped manifest — so the
   gating path and the effect paths are both covered, by different artifacts, on
   purpose.

## Transport — WebRTC not implemented; static hosting is

`Lockstep` drives a `Transport` interface (`send`, `onReceive`) and does not know
what one is. `web/src/netcode/loopback.ts` implements it in-process with
injectable latency, jitter and loss, driven by a **seeded** PRNG — a flaky netcode
test that cannot be replayed is worse than none, because it teaches you to re-run
it. A WebRTC implementation is a drop-in for that interface and nothing else has
to change.

The transport PRNG cannot affect determinism, and that is asserted rather than
argued: the transport decides only *when* a frame arrives, lockstep applies frames
by tick number, and `verify-lockstep` runs the same match over two different link
seeds and demands identical hashes.

- WebRTC DataChannel, `iceTransportPolicy: "relay"` — TURN only, so peer IPs are
  never exposed. **Recorded trade-off:** STUN would be free and unlimited, but
  TURN bandwidth is being spent deliberately to buy IP privacy. Do not silently
  relax it to "save bandwidth"; the maths below shows the cost is negligible.
  **Not implemented.**
- Cloudflare Realtime for TURN. **Not implemented.**
- Durable Objects: Lobby (signalling), Directory, Budget Gatekeeper. **Not
  implemented — and see the §6.6 rule below before any of them are.**
- Static assets. **Implemented** — `wrangler.jsonc`, deployed by the `deploy` job
  in `.github/workflows/ci.yml`.

### Static hosting

An **assets-only** Worker: an `assets` block and no `main`, so files are served
without a Worker invocation per request. Unknown paths get a real 404 rather than
`index.html`, because there is one route and no client-side router to hand them to.

**Divergence from §6.6, recorded rather than silent:** the spec says static assets
on Cloudflare *Pages*. This uses **Workers Static Assets**, the current successor
for this case — equally unmetered for static requests, and it keeps one platform
for when signalling arrives instead of Pages for the assets plus a Worker beside
them.

**It introduces no Durable Object**, so the architectural rule below is satisfied
by construction rather than by vigilance: there is nothing that could stay alive
during a match. That is the whole reason this landed separately from signalling.

**Cloudflare builds and deploys it**, through the git integration that already
exists. CI does not deploy at all, and that is the deliberate choice:

- The git integration authenticates **Cloudflare→GitHub** — it reads the repo and
  needs nothing from us. Deploying from GitHub Actions would have needed
  credentials in the **opposite** direction, a Cloudflare API token living in
  GitHub, because a runner is outside the Cloudflare account. (There is no OIDC
  federation to the Workers API, or that would have been the tokenless route.)
- The price is Rust. `web/public/diomano.wasm` is gitignored and compiled from
  `crates/diomano-wasm`, so producing `web/dist` needs cargo and the wasm32
  target, and the Workers image ships Node and Bun but not Rust. So
  `scripts/cloudflare-build.sh` installs the toolchain per build, with no cargo
  cache. Slower builds, no credentials — that is the trade, made on purpose.

Workers Builds settings this expects:

| setting | value |
|---|---|
| build command | `bash ./scripts/cloudflare-build.sh` |
| deploy command | `npx wrangler deploy` (the default) |

**Exactly one pipeline may publish the `amigo-diomano` Worker**, and it is that
integration. Two publishers on one name is a race whose loser silently wins
whenever it finishes second, so if the deploy is ever moved into CI, the git
integration has to be disconnected in the same change.

**One honest gap:** the rustup-install branch of that script cannot be exercised
anywhere Rust is already present, which is every machine this project is otherwise
built on. `just cf-build` runs the same script locally and will skip straight past
the install. If Cloudflare's image blocks the rustup download, the build fails there
and the fallback is to move the deploy to CI with a token.

`just deploy-check` validates the config with no credentials and runs inside `just
check`, so a malformed deploy config fails on the pull request rather than as a
failed deploy after merge. The script also refuses to finish if `web/dist` lacks
`index.html` or `diomano.wasm`: an assets-only Worker with no assets is a
*successful* deploy of a blank site, which is worse than a failed build.

## Free Tier budget

| Resource | Free limit |
|---|---|
| Workers requests | 100,000 / day |
| Workers CPU | 10 ms / request |
| Durable Objects requests | 100,000 / day |
| **Durable Objects duration** | **13,000 GB-s / day** |
| DO SQL storage | 5 GB (SQLite backend only on Free) |
| Realtime TURN egress | 1,000 GB / month |
| Pages bandwidth | unlimited |

Durable Objects on the Workers Free plan use the **SQLite storage backend only**.
The TURN free tier is **shared between TURN and SFU**, not two independent
allowances.

**Per-match traffic.** 8 bytes of payload inside a ~100 byte packet after
SCTP + DTLS + UDP + IP + TURN framing. At 30 Hz that is 3 KB/s per direction,
~6 KB/s per match, ~5.4 MB for 15 minutes — roughly 185,000 matches/month
against the TURN allowance. TURN is not a constraint.

Note the efficiency though: 8% payload. Overhead dominates completely.
`[START]` **batch 2 ticks per packet** — halves traffic for 66 ms of added
delay, comfortably inside the 200 ms input-delay budget.

**The binding constraint is Durable Object duration.** 13,000 GB-s/day at 128 MB
is ~28 DO-hours/day. A Lobby DO held open for a whole 15-minute match consumes
0.25 DO-hours, capping the platform at ~112 matches/day — ten times tighter than
DO requests and fifty times tighter than TURN.

**Architectural rule, not a quota to monitor: the Lobby DO must not stay alive
during a match.** With pure P2P lockstep it has nothing to do once the
connection is established. Signal, then exit. Where a connection genuinely must
persist, use the WebSocket Hibernation API — a hibernated DO accrues no duration.

With that rule the binding constraint returns to DO requests: ~30 per match,
about 3,300 matches/day.

This is failure mode 5, and it will never show up in testing because two people
playing one match will not notice. Phase 7's DoD measures for it explicitly:
**DO duration for a full match under 5 GB-s**, and if it scales with match
length the DO is still alive.

**Hard rule:** no per-tick server traffic, ever. The moment a tick touches a
Worker or DO, every budget above breaks.
