/**
 * Phase 7 DoD, minus the network: two independent simulations driven through the
 * lockstep layer over a lossy, latent link, asserted to stay bit-identical.
 *
 * Usage:  bun tools/verify-lockstep.ts
 *
 * # What this proves
 *
 * §6.1's DoD asks for "a full match played over a relayed connection with
 * simulated 120 ms RTT and 2% packet loss, without desync". The RTT and the loss
 * are simulated here rather than relayed, and that is the point: whether a delayed
 * frame arrived over a WebRTC DataChannel or out of an array is not something
 * `Lockstep` can observe. What it *can* observe — that a frame for tick N is
 * applied on tick N regardless of when it turned up — is exactly what is under
 * test.
 *
 * Two wasm instances in one process is honest here because the wasm module has
 * **zero imports**: there is no shared host state for them to leak through, and
 * `determinism::interleaved_worlds_do_not_contaminate_each_other` already pins the
 * same property on the native side.
 *
 * Five checks, in order:
 *
 * 1. the command codec produces the bytes `Command::encode` produces, on the same
 *    five vectors the Rust test pins;
 * 2. a 1,200-tick match over the DoD link completes without divergence;
 * 3. the same match over a different link schedule produces the same hashes, so
 *    arrival order provably never reaches the simulation;
 * 4. an injected divergence is caught — a detector never seen to fire is a comment;
 * 5. two failure modes that random loss almost never produces on purpose: every
 *    copy of one frame lost (the deadlock the resend window exists to prevent),
 *    and a command issued during a stall (the frame-mutation desync).
 *
 * # What this does not prove
 *
 * WebRTC, ICE, TURN relaying, DataChannel backpressure, signalling, Durable
 * Objects, and the "DO duration under 5 GB-s" budget of §6.6. All of those need a
 * deployed Cloudflare environment. See `docs/specs/netcode.md`.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Command, decodeCommand, decodeFrames, encodeCommand } from "../src/netcode/frame";
import {
  HASH_INTERVAL_TICKS,
  INPUT_DELAY_TICKS,
  Lockstep,
  type SimAdapter,
} from "../src/netcode/lockstep";
import { Link, type Transport } from "../src/netcode/loopback";

const WEB_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WASM_PATH = join(WEB_ROOT, "public/diomano.wasm");

const TICKS = 1_200;
const RTT_MS = 120;
const LOSS = 0.02;
const JITTER_MS = 30;
/** Real time between ticks at 30 Hz. Advances the link's clock, not a real one. */
const MS_PER_TICK = 1000 / 30;

interface WasmExports {
  dio_init(seed: number, terrain: number, ai: number): void;
  dio_push_command(
    player: number,
    verb: number,
    face: number,
    x: number,
    y: number,
    modifier: number,
  ): void;
  dio_tick(): void;
  dio_tick_count(): number;
  dio_hand_amount(player: number): number;
  dio_state_hash_lo(): number;
  dio_state_hash_hi(): number;
}

function fail(message: string): never {
  console.error(`verify-lockstep: ${message}`);
  process.exit(1);
}

/** A `SimAdapter` that also exposes the raw exports, for assertions. */
interface TestSim extends SimAdapter {
  handAmount(player: number): number;
}

/**
 * A simulation, optionally rigged to diverge at one tick.
 *
 * `corruptAt` injects one extra command that the other peer never sees, on the
 * tick where both peers are at the same count. Injecting an extra *tick* instead —
 * the obvious first attempt — proves nothing: each peer hashes at its own tick
 * count, so "90 ticks of the same input" hashes the same on both sides no matter
 * how their absolute counters drifted, and the detector correctly stayed silent.
 * A divergence has to be a difference in *state at the same tick*.
 *
 * `VERB_LOWER` at the starting settlement is the injection, because it is the one
 * verb certain to do something: digging needs no mana and no hand, and
 * `seed_starting_positions` guarantees face 4 cell (32, 32) is land.
 */
async function spawnSim(seed: number, corruptAt: number | null = null): Promise<TestSim> {
  const bytes = readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports as unknown as WasmExports;
  e.dio_init(seed, 0, 0);
  return {
    pushCommand(c: Command) {
      e.dio_push_command(c.player, c.verb, c.face, c.x, c.y, c.modifier);
    },
    tick() {
      if (corruptAt !== null && e.dio_tick_count() === corruptAt) {
        e.dio_push_command(1, 2, 4, 32, 32, 0);
      }
      e.dio_tick();
    },
    tickCount() {
      return e.dio_tick_count();
    },
    stateHash() {
      // Two u32 halves, because the ABI is `extern "C"` with no i64 in the
      // signature — the same reason `dio_state_hash_lo`/`_hi` exist at all.
      return (BigInt(e.dio_state_hash_hi() >>> 0) << 32n) | BigInt(e.dio_state_hash_lo() >>> 0);
    },
    handAmount(player: number) {
      return e.dio_hand_amount(player);
    },
  };
}

/** The same scripted input on both peers, but each only issues its own player's. */
function scriptFor(player: number, tick: number): Omit<Command, "tick" | "player"> | null {
  const phase = (tick + player * 37) % 120;
  const s = Math.floor(tick / 5);
  if (phase === 10) {
    return { verb: 2, face: 4 + player, x: (s * 3 + 7) % 64, y: (s * 5 + 11) % 64, modifier: 0 };
  }
  if (phase === 40) {
    return { verb: 1, face: 4 + player, x: (s * 7 + 2) % 64, y: (s * 3 + 19) % 64, modifier: 1 };
  }
  if (phase === 80) {
    return { verb: 3, face: 4 + player, x: (s * 11) % 64, y: (s * 13) % 64, modifier: 0 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The codec, against the bytes the Rust side pins
// ---------------------------------------------------------------------------

/**
 * The same five vectors as `command_wire_bytes_are_pinned_for_the_typescript_codec`
 * in `crates/diomano-sim/src/world.rs`. Both tests assert against these literal
 * bytes, so the two encoders can only drift together, never apart.
 */
const PINNED: [Command, number[]][] = [
  [{ tick: 0, player: 0, verb: 0, face: 0, x: 0, y: 0, modifier: 0 }, [0, 0, 0, 0, 0, 0, 0, 0]],
  [
    { tick: 1, player: 1, verb: 2, face: 4, x: 32, y: 32, modifier: 0 },
    [0x12, 0x01, 0x10, 0x20, 0x02, 0x00, 0x00, 0x00],
  ],
  [
    { tick: 123_456, player: 1, verb: 10, face: 5, x: 63, y: 63, modifier: 7 },
    [0x5a, 0x8f, 0x1f, 0x3f, 0x80, 0xc4, 0x03, 0x00],
  ],
  [
    { tick: 0x7fffffff, player: 3, verb: 15, face: 7, x: 511, y: 511, modifier: 63 },
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ],
  [
    { tick: 2, player: 0, verb: 3, face: 2, x: 5, y: 300, modifier: 1 },
    [0x83, 0x82, 0x02, 0x2c, 0x05, 0x00, 0x00, 0x00],
  ],
];

function theCodecMatchesTheRustLayout(): void {
  for (const [command, bytes] of PINNED) {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    encodeCommand(command, view, 0);
    const got = [...new Uint8Array(buf)];
    if (got.some((b, i) => b !== bytes[i])) {
      fail(
        `encodeCommand(${JSON.stringify(command)}) = [${got.join(", ")}], ` +
          `Rust pins [${bytes.join(", ")}] — the two codecs have drifted apart`,
      );
    }
    const back = decodeCommand(view, 0);
    for (const key of Object.keys(command) as (keyof Command)[]) {
      if (back[key] !== command[key]) {
        fail(`decodeCommand did not invert encodeCommand on ${key} for ${JSON.stringify(command)}`);
      }
    }
  }
  console.log(`verify-lockstep: codec matches the Rust layout on ${PINNED.length} pinned vectors`);
}

// ---------------------------------------------------------------------------
// 2–4. A lossy, latent match
// ---------------------------------------------------------------------------

interface RunResult {
  hashes: Map<number, bigint>;
  desyncTick: number | null;
  stalled: number;
  dropped: number;
  /** The tick both peers reached — the lower of the two. */
  ticks: number;
}

/**
 * Run a match. `corrupt` injects an extra command into peer B at that tick,
 * simulating a divergence, so the desync detector can be shown to *fire* rather
 * than assumed to.
 */
async function runMatch(linkSeed: number, corruptAtTick: number | null): Promise<RunResult> {
  const simA = await spawnSim(0x5eed);
  const simB = await spawnSim(0x5eed, corruptAtTick);
  const link = new Link({ rttMs: RTT_MS, loss: LOSS, jitterMs: JITTER_MS, seed: linkSeed });

  let desyncTick: number | null = null;
  const onDesync = (r: { tick: number }) => {
    if (desyncTick === null) desyncTick = r.tick;
  };

  const a = new Lockstep({ transport: link.a, sim: simA, localPlayer: 0, onDesync });
  const b = new Lockstep({ transport: link.b, sim: simB, localPlayer: 1, onDesync });

  const hashes = new Map<number, bigint>();
  // Issue each tick's scripted command once per tick, not once per loop
  // iteration: during a stall the tick does not move and a driver that re-read the
  // script would issue the same command again. A real driver issues on input
  // events and has the same property for free.
  const issuedThrough = [-1, -1];
  let guard = 0;

  // Both peers must finish, not only A: B may legitimately trail by up to
  // `MAX_PEER_LAG_TICKS`, and a check on A alone would call that a stall.
  while ((simA.tickCount() < TICKS || simB.tickCount() < TICKS) && guard < TICKS * 200) {
    guard++;

    for (const [peer, sim, player] of [
      [a, simA, 0],
      [b, simB, 1],
    ] as const) {
      const t = sim.tickCount();
      if (t === issuedThrough[player]) continue;
      issuedThrough[player] = t;
      const cmd = scriptFor(player, t);
      if (cmd !== null) peer.issue({ ...cmd, player });
    }

    const movedA = a.step();
    const movedB = b.step();

    // Exchange hashes at the §6.3 interval, in both directions.
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      for (let t = HASH_INTERVAL_TICKS; t <= TICKS; t += HASH_INTERVAL_TICKS) {
        const h = from.hashFor(t);
        if (h !== undefined) to.receiveHash(t, h);
      }
    }

    if (a.halted || b.halted) break;

    // Nothing moved and nothing is in flight: a genuine deadlock rather than a
    // wait. Reported rather than spun on, because an infinite loop in a test is
    // indistinguishable from a slow one.
    if (!movedA && !movedB && link.inFlight === 0) {
      a.flush();
      b.flush();
      link.advance(MS_PER_TICK);
      continue;
    }
    link.advance(MS_PER_TICK);

    const t = simA.tickCount();
    if (t > 0 && t % HASH_INTERVAL_TICKS === 0 && !hashes.has(t)) {
      hashes.set(t, simA.stateHash());
    }
  }

  return {
    hashes,
    desyncTick,
    stalled: a.stalledTicks + b.stalledTicks,
    dropped: link.dropped,
    ticks: Math.min(simA.tickCount(), simB.tickCount()),
  };
}

// ---------------------------------------------------------------------------
// 5. Directed failures
// ---------------------------------------------------------------------------

/**
 * A link with explicit control: packets are held until `pump`, and either
 * direction can be filtered. Random loss finds the two cases below about once per
 * ten thousand matches; a test has to make them happen on purpose.
 */
class ManualLink {
  readonly a: Transport;
  readonly b: Transport;
  private toA: Uint8Array[] = [];
  private toB: Uint8Array[] = [];
  private handlerA: ((p: Uint8Array) => void) | null = null;
  private handlerB: ((p: Uint8Array) => void) | null = null;
  /** While set, packets towards that peer queue up instead of arriving. */
  holdToA = false;
  /** Return `true` to drop a packet A sends. */
  dropFromA: (packet: Uint8Array) => boolean = () => false;

  constructor() {
    this.a = {
      send: (p) => {
        if (!this.dropFromA(p)) this.toB.push(p);
      },
      onReceive: (h) => {
        this.handlerA = h;
      },
    };
    this.b = {
      send: (p) => this.toA.push(p),
      onReceive: (h) => {
        this.handlerB = h;
      },
    };
  }

  /** Deliver everything queued, in order, unless held. */
  pump(): void {
    for (const p of this.toB.splice(0)) this.handlerB?.(p);
    if (!this.holdToA) for (const p of this.toA.splice(0)) this.handlerA?.(p);
  }
}

interface Pair {
  simA: TestSim;
  simB: TestSim;
  a: Lockstep;
  b: Lockstep;
  link: ManualLink;
  /** Step both peers and pump the link until both have reached `until`. */
  runTo(until: number, what: string): void;
}

async function pair(): Promise<Pair> {
  const simA = await spawnSim(0x5eed);
  const simB = await spawnSim(0x5eed);
  const link = new ManualLink();
  const a = new Lockstep({ transport: link.a, sim: simA, localPlayer: 0 });
  const b = new Lockstep({ transport: link.b, sim: simB, localPlayer: 1 });
  return {
    simA,
    simB,
    a,
    b,
    link,
    runTo(until, what) {
      let guard = 0;
      const stuck = (): never =>
        fail(`${what}: deadlocked at ticks ${simA.tickCount()} / ${simB.tickCount()} of ${until}`);
      while (simA.tickCount() < until || simB.tickCount() < until) {
        a.step();
        b.step();
        link.pump();
        if (guard++ > until * 50) stuck();
      }
      // Level the two off — one may be a few ticks ahead — so that the hashes the
      // callers compare are for the same tick. The tick count is hashed.
      while (simA.tickCount() < simB.tickCount()) {
        a.step();
        link.pump();
        if (guard++ > until * 50) stuck();
      }
      while (simB.tickCount() < simA.tickCount()) {
        b.step();
        link.pump();
        if (guard++ > until * 50) stuck();
      }
    },
  };
}

/**
 * Every copy of one frame lost. Before the window was anchored to the peer's
 * needs this was a guaranteed deadlock: A ran on past the lost tick, dropped it
 * from its window, and B waited for it forever.
 */
async function aFrameLostInEveryCopyIsStillDelivered(): Promise<void> {
  const p = await pair();
  const LOST = 20;
  // Lose A's frame 20 in every packet A sends while A itself has not passed
  // tick 20 — the burst that takes out the original transmissions. Once A moves
  // on, the window must still be carrying the frame.
  p.link.dropFromA = (packet) =>
    p.simA.tickCount() <= LOST && decodeFrames(packet).some((f) => f.tick === LOST);
  // Far enough that A has run its full lead over B, stalled, and been rescued.
  p.runTo(LOST + 2 * INPUT_DELAY_TICKS + 20, "burst loss of one frame");
  if (p.simA.stateHash() !== p.simB.stateHash()) fail("burst loss produced a divergence");
  console.log("                 a frame lost in every copy was resent and the match went on");
}

/**
 * A command issued while stalled. Before `issue` respected `sentThrough`, the
 * command landed in a frame the peer already held an empty copy of: applied on
 * one side, ignored on the other.
 */
async function aCommandIssuedDuringAStallReachesBothPeers(): Promise<void> {
  const p = await pair();
  p.runTo(20, "warm-up");

  // Silence B towards A until A runs out of remote input and stalls.
  p.link.holdToA = true;
  let guard = 0;
  while (p.a.step()) {
    p.link.pump();
    if (guard++ > 100) fail("A never stalled with the peer silenced");
  }
  // Make sure A's whole window, including the frame the stall points at, has
  // already reached B before the command exists.
  p.a.flush();
  p.link.pump();
  const stalledAt = p.simA.tickCount();
  const before = p.simA.handAmount(0);
  p.a.issue({ verb: 2, face: 4, x: 32, y: 32, modifier: 0, player: 0 });
  p.link.holdToA = false;
  p.link.pump();

  p.runTo(stalledAt + 40, "after a stall");
  if (p.simA.stateHash() !== p.simB.stateHash()) {
    fail("a command issued during a stall was applied on one peer only");
  }
  if (p.simA.handAmount(0) <= before || p.simB.handAmount(0) !== p.simA.handAmount(0)) {
    fail("the command issued during the stall was not applied on both peers");
  }
  console.log(
    `                 a command issued during a stall (tick ${stalledAt}) reached both peers`,
  );
}

// ---------------------------------------------------------------------------

theCodecMatchesTheRustLayout();

const clean = await runMatch(0xa11ce, null);

if (clean.ticks < TICKS) {
  fail(`match stalled out at tick ${clean.ticks} of ${TICKS} — lockstep did not make progress`);
}
if (clean.desyncTick !== null) {
  fail(`desync at tick ${clean.desyncTick} on a clean link — the peers diverged`);
}
if (clean.dropped === 0) {
  fail(`the link dropped no packets at ${LOSS * 100}% loss — the test is not testing loss`);
}
console.log(
  `verify-lockstep: OK — ${clean.ticks} ticks at ${RTT_MS} ms RTT, ` +
    `${LOSS * 100}% loss, ${JITTER_MS} ms jitter`,
);
console.log(
  `                 ${clean.dropped} packets dropped, ${clean.stalled} stalled tick-attempts, ` +
    `${clean.hashes.size} hashes compared`,
);

// The same match over a different link schedule must produce the same hashes.
// This is the property that makes lockstep worth having: the network decides
// *when* a frame arrives and never *what* the result is.
const reordered = await runMatch(0xb0b, null);
if (reordered.ticks < TICKS) {
  fail(`match over the second link stalled out at tick ${reordered.ticks} of ${TICKS}`);
}
if (reordered.desyncTick !== null) {
  fail(`desync at tick ${reordered.desyncTick} on the second link`);
}
if (reordered.hashes.size !== clean.hashes.size) {
  fail(`the two runs compared ${clean.hashes.size} and ${reordered.hashes.size} hashes`);
}
for (const [tick, hash] of clean.hashes) {
  const other = reordered.hashes.get(tick);
  if (other === undefined) fail(`the second run recorded no hash for tick ${tick}`);
  if (other !== hash) {
    fail(
      `tick ${tick} differs between two link schedules: ` +
        `${hash.toString(16)} vs ${other.toString(16)} — arrival order reached the simulation`,
    );
  }
}
console.log(
  `                 hashes identical across two link schedules (${clean.dropped} vs ${reordered.dropped} drops)`,
);

// And the detector must fire. A desync check that has never been seen to trip is
// a comment, not a check.
const corrupted = await runMatch(0xa11ce, 300);
if (corrupted.desyncTick === null) {
  fail("injected a divergence and the desync detector stayed silent");
}
console.log(`                 injected divergence caught at tick ${corrupted.desyncTick}`);

await aFrameLostInEveryCopyIsStillDelivered();
await aCommandIssuedDuringAStallReachesBothPeers();
