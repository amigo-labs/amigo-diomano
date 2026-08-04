# Multiplayer and netcode

Split from `docs/HANDOFF.md` §6 (Phase 0).

> **Nothing in this file is implemented.** Phase 7 is explicitly out of scope for
> this run: no WebRTC, no lockstep loop, no command frames on a wire, no Durable
> Objects, no Cloudflare anything. A half-built netcode layer is worse than none.
>
> What *is* done is the shape that makes adding it a transport concern and
> nothing more, plus the determinism guarantee it rests on. Both are recorded
> below so the next phase starts from evidence rather than from hope.

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

## Command frames

Packed to 8 bytes. Every tick both clients exchange a frame, empty frames
included, so a silent peer is distinguishable from a stalled one.

**Input delay: 6 ticks (200 ms)** `[START]`. Generous by action-game standards
and invisible in this genre — spend the latency budget here rather than risking
stalls. This is pillar 2 in practice: indirect control *is* the latency
strategy, which is why the genre was chosen.

Gesture recognition runs entirely client-side; only the result enters the
command stream. It already samples on a fixed timer rather than per frame, which
is the half of §6.2 that this run did implement.

## Desync detection

Hash every 30 ticks; on mismatch halt immediately, dump both states plus the
input log, and do not attempt to resync.

CI acceptance criterion `[START]`: 10 recorded matches of ≥ 20,000 ticks each,
covering every verb at least 20 times and at least 200 combat resolutions,
replaying bit-identically native vs. headless browser.

**This run ships 1 fixture of 2,400 ticks.** The harness (`just record`,
`just verify`, `just verify-cross`) is complete; only the corpus is small.
Raising it is a matter of a longer script and more `just record` invocations.

## Transport

- WebRTC DataChannel, `iceTransportPolicy: "relay"` — TURN only, so peer IPs are
  never exposed. **Recorded trade-off:** STUN would be free and unlimited, but
  TURN bandwidth is being spent deliberately to buy IP privacy. Do not silently
  relax it to "save bandwidth"; the maths below shows the cost is negligible.
- Cloudflare Realtime for TURN.
- Durable Objects: Lobby (signalling), Directory, Budget Gatekeeper.
- Static assets on Cloudflare Pages: unlimited bandwidth.

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
