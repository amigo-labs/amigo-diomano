/**
 * Deterministic lockstep (HANDOFF §6.1, §6.2, §6.3).
 *
 * The whole architecture rests on one property, and this run already proved it:
 * native and browser builds produce identical state hashes over a recorded log
 * (`just verify-cross`). Given that, multiplayer is a question about *inputs*, and
 * this file is the answer — nothing here touches world state.
 *
 * # The rule this file exists to protect
 *
 * A tick is simulated only when every peer's input for that tick is known. Never
 * predict, never roll back, never resync. The genre is why that is affordable:
 * pillar 2 is indirect control, so 200 ms of input delay is invisible in a way it
 * would not be in an action game (§6.2). Spending the latency budget on delay
 * instead of on prediction is the whole reason this design is simple.
 *
 * # Deliberately not here
 *
 * WebRTC, TURN, signalling, Durable Objects, keyframes, reconnect. This drives a
 * [`Transport`] and does not know what one is. See `docs/specs/netcode.md` for
 * what remains and why it cannot be verified in this environment.
 */

import { type Command, type Frame, decodeFrames, encodeFrames } from "./frame";
import type { Transport } from "./loopback";

/**
 * Ticks between issuing a command and simulating it. `[START]`, §6.2.
 *
 * 6 ticks at 30 Hz is 200 ms. Generous by action-game standards and chosen on
 * purpose: a stall is far worse than a delay, and in this genre the delay does not
 * read as input lag.
 */
export const INPUT_DELAY_TICKS = 6;

/**
 * Ticks per packet. `[START]`, §6.6.
 *
 * 8 bytes of payload travel inside roughly 100 bytes of SCTP + DTLS + UDP + IP +
 * TURN framing, so payload is about 8% of the packet. Batching two ticks halves
 * the packet count for 66 ms of added delay, comfortably inside the 200 ms budget.
 */
export const TICKS_PER_PACKET = 2;

/** Ticks between state-hash comparisons, §6.3. */
export const HASH_INTERVAL_TICKS = 30;

/**
 * Every packet carries the whole *unsimulated* input window, not just what is new.
 *
 * Lockstep cannot proceed past a tick whose input it does not have, so a dropped
 * packet is not a hiccup — it is a hard stop until that frame arrives some other
 * way. Measured, before this: a match over a 2% loss link deadlocked at tick 20.
 *
 * The obvious fix is a reliable ordered DataChannel and letting SCTP retransmit.
 * Repeating the window instead costs bytes rather than latency, and §6.6 already
 * establishes bytes are not the constraint: a retransmit costs a full round trip
 * (120 ms, most of the 200 ms input-delay budget), while the entire window is
 * `INPUT_DELAY_TICKS + 1` frames — 56 bytes, inside the ~100 bytes of SCTP + DTLS
 * + UDP + IP + TURN framing that every packet pays anyway.
 *
 * Sending the *window* rather than a fixed tail of history is deliberate, and the
 * first attempt got it wrong in an instructive way: a fixed 6-frame tail could not
 * hold the 7 frames the opening burst publishes, so tick 0 was evicted before it
 * was ever transmitted and the match deadlocked on its own first tick. Anchoring
 * the window to "what the peer has not simulated yet" makes that unrepresentable —
 * a frame stops being sent when it can no longer be needed, and not before.
 *
 * Each frame therefore gets up to `INPUT_DELAY_TICKS + 1` chances to arrive. At 2%
 * independent loss, missing all seven is about 1 in 10^12. Correlated loss — a
 * burst taking every copy — is not covered, and the answer there is the stall path
 * rather than a guarantee: `step` reports and waits instead of inventing input.
 */
export const WINDOW_FRAMES = INPUT_DELAY_TICKS + 1;

/** The simulation, as lockstep needs to see it. */
export interface SimAdapter {
  /** Queue a command for the next [`SimAdapter.tick`]. */
  pushCommand(c: Command): void;
  tick(): void;
  /** Ticks simulated so far. */
  tickCount(): number;
  /** Full state hash. §6.3 uses this to detect divergence. */
  stateHash(): bigint;
}

export interface DesyncReport {
  tick: number;
  local: bigint;
  remote: bigint;
  /** Every frame applied so far, so a desync can be replayed offline (§6.3). */
  inputLog: Frame[];
}

export interface LockstepOptions {
  transport: Transport;
  sim: SimAdapter;
  /** Which player this peer controls. Commands are stamped with it. */
  localPlayer: number;
  onDesync?: (r: DesyncReport) => void;
  onStall?: (waitingForTick: number) => void;
}

/**
 * A hash the peer reported for a tick we have not reached yet.
 *
 * Kept rather than discarded: at 120 ms RTT a peer can be a few ticks ahead, so
 * its hash for tick N routinely arrives before we simulate N. Dropping it would
 * silently disable desync detection for exactly the ticks under load, which is
 * where a desync is most likely.
 */
type HashClaim = { tick: number; hash: bigint };

export class Lockstep {
  private readonly opts: LockstepOptions;
  /** Remote input, by tick. A tick is runnable once its entry exists. */
  private readonly remote = new Map<number, Command[]>();
  /** Local input, by the tick it will be simulated on. */
  private readonly local = new Map<number, Command[]>();
  private readonly hashClaims: HashClaim[] = [];
  private readonly ownHashes = new Map<number, bigint>();
  private readonly inputLog: Frame[] = [];

  /** Set once a mismatch is seen. Terminal: §6.3 forbids resyncing. */
  halted = false;
  haltReason: DesyncReport | null = null;
  /** Ticks spent waiting for remote input. The stall metric of §6.1. */
  stalledTicks = 0;

  constructor(options: LockstepOptions) {
    this.opts = options;
    options.transport.onReceive((p) => this.receive(p));
  }

  /**
   * Queue a local command.
   *
   * It is scheduled `INPUT_DELAY_TICKS` ahead — not applied now — so both peers
   * simulate it on the same tick. This is the only place the delay is applied, and
   * the reason gesture recognition can stay entirely client-side (§6.2): what
   * crosses the wire is already a decided `(verb, modifier)`.
   */
  issue(c: Omit<Command, "tick">): void {
    const tick = this.opts.sim.tickCount() + INPUT_DELAY_TICKS;
    const at = this.local.get(tick) ?? [];
    at.push({ ...c, tick, player: this.opts.localPlayer });
    this.local.set(tick, at);
  }

  /**
   * Send input for every tick up to the delay horizon.
   *
   * Empty frames included — §6.1 requires it, so that a peer with nothing to say
   * is distinguishable from one that has stopped. This is also what makes the
   * remote map fill up for quiet ticks, and therefore what stops a quiet peer from
   * reading as a stall.
   */
  private publish(): void {
    const now = this.opts.sim.tickCount();
    const horizon = now + INPUT_DELAY_TICKS;
    let fresh = 0;
    for (let t = this.sentThrough + 1; t <= horizon; t++) {
      this.sentThrough = t;
      fresh++;
    }
    // Frames older than our own current tick can no longer be needed by a peer
    // that is at most `INPUT_DELAY_TICKS` behind, so the window starts here.
    this.windowFrom = now;
    this.sinceSend += fresh;
    if (this.sinceSend >= TICKS_PER_PACKET) {
      this.sinceSend = 0;
      this.sendWindow();
    }
  }

  /** Send every frame the peer might still need: `[windowFrom, sentThrough]`. */
  private sendWindow(): void {
    const frames: Frame[] = [];
    for (let t = this.windowFrom; t <= this.sentThrough; t++) {
      frames.push({ tick: t, commands: this.local.get(t) ?? [] });
    }
    if (frames.length > 0) this.opts.transport.send(encodeFrames(frames));
  }

  private sentThrough = -1;
  private windowFrom = 0;
  private sinceSend = 0;

  /**
   * Resend the window immediately.
   *
   * Called when the loop is waiting on the peer: a frame that was dropped will not
   * be re-offered by `publish` until the tick counter moves, and the tick counter
   * cannot move until the frame arrives. This is the path that turns a burst loss
   * into a delay rather than a deadlock.
   */
  flush(): void {
    this.sendWindow();
  }

  private receive(packet: Uint8Array): void {
    for (const f of decodeFrames(packet)) {
      // A hash claim rides on the frame's flags in a later revision; for now the
      // peer sends hashes as ordinary frames on a reserved verb-free tick channel,
      // so `receiveHash` is called explicitly by the driver. Keeping the two paths
      // separate means a malformed hash cannot corrupt the input stream.
      if (!this.remote.has(f.tick)) this.remote.set(f.tick, f.commands);
    }
  }

  /** Report the peer's hash for a tick. */
  receiveHash(tick: number, hash: bigint): void {
    const own = this.ownHashes.get(tick);
    if (own === undefined) {
      this.hashClaims.push({ tick, hash });
      return;
    }
    this.compare(tick, own, hash);
  }

  /** The local hash for a tick, to be sent to the peer. */
  hashFor(tick: number): bigint | undefined {
    return this.ownHashes.get(tick);
  }

  private compare(tick: number, local: bigint, remote: bigint): void {
    if (local === remote || this.halted) return;
    // §6.3: halt immediately, dump both states plus the input log, do not attempt
    // to resync. A resync would paper over the bug that caused the divergence, and
    // the bug is the only thing that matters here.
    this.halted = true;
    this.haltReason = { tick, local, remote, inputLog: [...this.inputLog] };
    this.opts.onDesync?.(this.haltReason);
  }

  /**
   * Simulate one tick, if it is runnable.
   *
   * Returns `true` if a tick was simulated, `false` if we are waiting on the peer
   * or halted. A caller that ignores the return value and loops will spin; that is
   * the caller's business, and reporting the stall is this function's.
   */
  step(): boolean {
    if (this.halted) return false;
    this.publish();

    const next = this.opts.sim.tickCount();
    const remoteInput = this.remote.get(next);
    if (remoteInput === undefined) {
      this.stalledTicks++;
      this.opts.onStall?.(next);
      return false;
    }

    // Both sides' commands for this tick, local first then remote. Order matters:
    // `World::tick` applies the slice in order, so the two peers must agree on it.
    // Sorting by player id is what makes that agreement independent of who is
    // "local", which differs between the two peers by definition.
    const frame: Frame = {
      tick: next,
      commands: [...(this.local.get(next) ?? []), ...remoteInput].sort(
        (p, q) => p.player - q.player,
      ),
    };
    for (const c of frame.commands) this.opts.sim.pushCommand(c);
    this.inputLog.push(frame);
    this.local.delete(next);
    this.remote.delete(next);

    this.opts.sim.tick();

    const now = this.opts.sim.tickCount();
    if (now % HASH_INTERVAL_TICKS === 0) {
      const h = this.opts.sim.stateHash();
      this.ownHashes.set(now, h);
      // Any claim we could not check when it arrived, we can check now.
      for (let i = this.hashClaims.length - 1; i >= 0; i--) {
        const claim = this.hashClaims[i];
        if (claim === undefined) continue;
        if (claim.tick === now) {
          this.hashClaims.splice(i, 1);
          this.compare(now, h, claim.hash);
        }
      }
    }
    return true;
  }
}
