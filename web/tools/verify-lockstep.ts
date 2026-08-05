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
 * # What this does not prove
 *
 * WebRTC, ICE, TURN relaying, DataChannel backpressure, signalling, Durable
 * Objects, and the "DO duration under 5 GB-s" budget of §6.6. All of those need a
 * deployed Cloudflare environment. See `docs/specs/netcode.md`.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "../src/netcode/frame";
import { HASH_INTERVAL_TICKS, Lockstep, type SimAdapter } from "../src/netcode/lockstep";
import { Link } from "../src/netcode/loopback";

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
  dio_state_hash_lo(): number;
  dio_state_hash_hi(): number;
}

function fail(message: string): never {
  console.error(`verify-lockstep: ${message}`);
  process.exit(1);
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
async function spawnSim(seed: number, corruptAt: number | null = null): Promise<SimAdapter> {
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

interface RunResult {
  hashes: Map<number, bigint>;
  desyncTick: number | null;
  stalled: number;
  dropped: number;
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
  let guard = 0;

  while (simA.tickCount() < TICKS && guard < TICKS * 200) {
    guard++;

    for (const [peer, sim, player] of [
      [a, simA, 0],
      [b, simB, 1],
    ] as const) {
      const cmd = scriptFor(player, sim.tickCount());
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
if (reordered.desyncTick !== null)
  fail(`desync at tick ${reordered.desyncTick} on the second link`);
for (const [tick, hash] of clean.hashes) {
  const other = reordered.hashes.get(tick);
  if (other === undefined) continue;
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
