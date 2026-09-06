/**
 * An in-process transport with injectable latency and loss.
 *
 * Phase 7's DoD asks for a full match over a relayed connection at 120 ms RTT and
 * 2% packet loss, without desync. That number is measurable here, without a
 * network: lockstep either tolerates a delayed packet or it does not, and whether
 * the delay came from a WebRTC DataChannel or from an array of pending deliveries
 * is not something the loop can tell.
 *
 * What this deliberately does *not* test is WebRTC itself — ICE, TURN relaying,
 * DataChannel backpressure. Those need a deployed Cloudflare environment and are
 * out of scope for this run (see `docs/specs/netcode.md`). The interface below is
 * the seam they plug into.
 *
 * # Reproducibility
 *
 * Latency jitter and loss come from a seeded PRNG, never `Math.random`. A flaky
 * netcode test that cannot be replayed is worse than no test: it trains you to
 * re-run it. Same seed, same packet schedule, same result.
 */

/** What lockstep needs of a transport, and nothing more. */
export interface Transport {
  send(packet: Uint8Array): void;
  /** Called with each packet as it becomes deliverable. */
  onReceive(handler: (packet: Uint8Array) => void): void;
}

export interface LinkOptions {
  /** Round-trip time in ms. One-way delay is half of it. */
  rttMs: number;
  /** Fraction of packets dropped, 0..1. */
  loss: number;
  /** Jitter in ms, applied as +/- half this value. */
  jitterMs?: number;
  seed?: number;
}

/**
 * SplitMix64's mixing step, narrowed to 32 bits.
 *
 * Deliberately the same *shape* as `hash::SplitMix64` in the sim rather than a
 * different generator — but note it is only used for the *network*, never for
 * anything the simulation observes. A PRNG on the transport side cannot affect
 * determinism, because the transport only decides *when* a frame arrives, and
 * lockstep applies frames by tick number rather than by arrival order. That
 * property is what `web/tools/verify-lockstep.ts` checks by running the same
 * match over two different link seeds and demanding the same hashes.
 */
function mix32(state: { s: number }): number {
  state.s = (state.s + 0x9e3779b9) >>> 0;
  let z = state.s;
  z = (Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0) >>> 0;
  z = (Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

interface Pending {
  at: number;
  packet: Uint8Array;
}

/**
 * A pair of transports connected to each other.
 *
 * Time is explicit: nothing is delivered until [`Link.advance`] is called. A test
 * that drove this from a real clock would be a test of the machine it ran on.
 */
export class Link {
  readonly a: Transport;
  readonly b: Transport;
  private nowMs = 0;
  private readonly rng: { s: number };
  private readonly opts: Required<LinkOptions>;
  private toA: Pending[] = [];
  private toB: Pending[] = [];
  private handlerA: ((p: Uint8Array) => void) | null = null;
  private handlerB: ((p: Uint8Array) => void) | null = null;
  /** Counted so a test can assert the link actually dropped something. */
  dropped = 0;
  delivered = 0;

  constructor(options: LinkOptions) {
    this.opts = {
      jitterMs: 0,
      seed: 0x5eed,
      ...options,
    };
    this.rng = { s: this.opts.seed >>> 0 };
    this.a = {
      send: (p) => this.queue(this.toB, p),
      onReceive: (h) => {
        this.handlerA = h;
      },
    };
    this.b = {
      send: (p) => this.queue(this.toA, p),
      onReceive: (h) => {
        this.handlerB = h;
      },
    };
  }

  private queue(into: Pending[], packet: Uint8Array): void {
    // Loss is decided at send time, so a dropped packet costs nothing later.
    if (this.opts.loss > 0 && mix32(this.rng) / 0x1_0000_0000 < this.opts.loss) {
      this.dropped++;
      return;
    }
    let delay = this.opts.rttMs / 2;
    if (this.opts.jitterMs > 0) {
      const j = (mix32(this.rng) / 0x1_0000_0000 - 0.5) * this.opts.jitterMs;
      delay = Math.max(0, delay + j);
    }
    into.push({ at: this.nowMs + delay, packet });
  }

  /**
   * Move time forward and deliver whatever has come due.
   *
   * Delivery is in `at` order, and ties break by insertion order, because a
   * transport that reorders arbitrarily would make failures unreproducible for a
   * reason that has nothing to do with the code under test. Real UDP does reorder;
   * `jitterMs` is how that gets exercised, deliberately rather than incidentally.
   */
  advance(ms: number): void {
    this.nowMs += ms;
    this.flush(this.toA, () => this.handlerA);
    this.flush(this.toB, () => this.handlerB);
  }

  private flush(queue: Pending[], handler: () => ((p: Uint8Array) => void) | null): void {
    const due = queue.filter((p) => p.at <= this.nowMs);
    if (due.length === 0) return;
    const rest = queue.filter((p) => p.at > this.nowMs);
    queue.length = 0;
    queue.push(...rest);
    due.sort((x, y) => x.at - y.at);
    const h = handler();
    for (const p of due) {
      this.delivered++;
      if (h !== null) h(p.packet);
    }
  }

  /** Packets still in flight. Used to drain the link at end of match. */
  get inFlight(): number {
    return this.toA.length + this.toB.length;
  }
}
