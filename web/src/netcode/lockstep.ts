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
 * A packet pays roughly 100 bytes of SCTP + DTLS + UDP + IP + TURN framing
 * whatever it carries — §6.6 was written when it carried one 8-byte frame, i.e.
 * 8% payload; with the whole `WINDOW_FRAMES` window aboard it is ~112 bytes of
 * headers plus commands, about half and half. Either way the framing is the
 * cost, so batching two ticks per packet halves it for 66 ms of added delay,
 * comfortably inside the 200 ms budget.
 */
export const TICKS_PER_PACKET = 2;

/** Ticks between state-hash comparisons, §6.3. */
export const HASH_INTERVAL_TICKS = 30;

/**
 * How far behind us the peer can be, in ticks.
 *
 * We simulate tick T only once we hold the peer's frame for T, and the peer
 * publishes `INPUT_DELAY_TICKS` ahead of its own tick. Standing at `now` therefore
 * proves the peer has published through `now - 1` at least, so it is at
 * `now - 1 - INPUT_DELAY_TICKS` or later. Everything older it has simulated and
 * can never need again; everything from there on it may still be waiting for.
 * The bound is symmetric, so the peer can be at most this far *ahead* as well.
 */
export const MAX_PEER_LAG_TICKS = INPUT_DELAY_TICKS + 1;

/**
 * Every packet carries every frame the peer might still need, not just what is new.
 *
 * Lockstep cannot proceed past a tick whose input it does not have, so a dropped
 * packet is not a hiccup — it is a hard stop until that frame arrives some other
 * way. Measured, before this: a match over a 2% loss link deadlocked at tick 20.
 *
 * The obvious fix is a reliable ordered DataChannel and letting SCTP retransmit.
 * Repeating the window instead costs bytes rather than latency, and §6.6 already
 * establishes bytes are not the constraint: a retransmit costs a full round trip
 * (120 ms, most of the 200 ms input-delay budget), while the entire window is
 * `WINDOW_FRAMES` empty frames, 112 bytes, in the same order as the ~100 bytes of
 * SCTP + DTLS + UDP + IP + TURN framing every packet pays anyway.
 *
 * The window runs from the oldest tick the peer can still be waiting on,
 * `now - MAX_PEER_LAG_TICKS`, to our publish horizon, `now + INPUT_DELAY_TICKS`.
 * The lower end is the part that was wrong once. The first version started the
 * window at our *own* tick, reasoning that a frame we had already simulated could
 * not be needed — but what we simulated tick T with was the *peer's* frame T, and
 * the peer still needs ours. It can be up to `MAX_PEER_LAG_TICKS` behind, so once
 * every packet carrying our frame T was lost (at `TICKS_PER_PACKET = 2` that is
 * three or four packets, not the seven the tick count suggests), the peer stalled
 * on T for good while we ran ahead, evicted T from the window, and then stalled
 * ourselves — with `flush` resending a window that no longer held the one frame
 * that mattered. Anchoring the window to what the peer can still need makes that
 * unrepresentable: a frame stops being sent when it can no longer be needed, and
 * not before.
 *
 * Correlated loss beyond that — every copy of a frame lost while it is in the
 * window — is answered by the stall path: `step` reports, waits, and keeps
 * resending the window rather than inventing input.
 */
export const WINDOW_FRAMES = MAX_PEER_LAG_TICKS + INPUT_DELAY_TICKS + 1;

/**
 * While waiting on the peer, resend the window every this many `step` attempts.
 *
 * `publish` only sends when the tick counter moves, and during a stall it does
 * not — exactly when the peer is most likely to be missing one of our frames.
 * Two attempts rather than one so that a driver calling `step` at frame rate does
 * not double the packet rate the moment it waits.
 */
export const STALL_RESEND_EVERY = 2;

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
  /**
   * Packets that did not decode, or carried a frame for a tick the peer cannot
   * honestly be at. One count per packet, however many of its frames were bad.
   * Counted and dropped, never applied: a malformed packet must not take the
   * remaining packets of a batch down with it, nor seed the input map with keys
   * nothing will ever delete.
   */
  rejectedPackets = 0;

  /** The newest tick whose frame has been published. */
  private sentThrough = -1;
  private sinceSend = 0;
  private stallsSinceSend = 0;

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
   *
   * And never into a frame that has already been published. The peer keeps the
   * first copy of a frame it receives (`receive`), so a frame is immutable from
   * its first `sendWindow` on. The two rules agree except during a stall, when the
   * tick counter stands still while `sentThrough` has moved on: a command issued
   * then landed in a frame the peer already held an empty copy of, was applied
   * here and nowhere else, and the match diverged at the next hash.
   */
  issue(c: Omit<Command, "tick">): void {
    const tick = Math.max(this.opts.sim.tickCount() + INPUT_DELAY_TICKS, this.sentThrough + 1);
    const at = this.local.get(tick) ?? [];
    at.push({ ...c, tick, player: this.opts.localPlayer });
    this.local.set(tick, at);
  }

  /**
   * Publish input for every tick up to the delay horizon.
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
    this.sinceSend += fresh;
    if (this.sinceSend >= TICKS_PER_PACKET) {
      this.sinceSend = 0;
      this.sendWindow();
    }
  }

  /** The oldest tick the peer may still be waiting on — see `WINDOW_FRAMES`. */
  private windowFrom(): number {
    return Math.max(0, this.opts.sim.tickCount() - MAX_PEER_LAG_TICKS);
  }

  /**
   * Send every frame the peer might still need: `[windowFrom, sentThrough]`.
   *
   * The lower bound is computed here, from the tick as it is *now*, rather than
   * remembered from `publish`: `step` deletes the local frame that falls out of
   * the window after each tick, and a remembered bound from before that tick
   * still reached one frame further back — so a `flush` between the two sent an
   * empty frame for a tick that had carried a command.
   */
  private sendWindow(): void {
    const frames: Frame[] = [];
    for (let t = this.windowFrom(); t <= this.sentThrough; t++) {
      frames.push({ tick: t, commands: this.local.get(t) ?? [] });
    }
    if (frames.length > 0) this.opts.transport.send(encodeFrames(frames));
    this.stallsSinceSend = 0;
  }

  /**
   * Resend the window immediately.
   *
   * `step` does this on its own while it waits; a driver may also call it when
   * it learns something the loop cannot see, such as a transport reconnecting.
   */
  flush(): void {
    this.sendWindow();
  }

  private receive(packet: Uint8Array): void {
    let frames: Frame[];
    try {
      frames = decodeFrames(packet);
    } catch {
      this.rejectedPackets++;
      return;
    }
    const now = this.opts.sim.tickCount();
    // The peer can be at most `MAX_PEER_LAG_TICKS` ahead of us and publishes
    // `INPUT_DELAY_TICKS` past that; anything further is not an honest frame.
    const horizon = now + MAX_PEER_LAG_TICKS + INPUT_DELAY_TICKS;
    let rejected = false;
    for (const f of frames) {
      if (f.tick > horizon) {
        rejected = true;
        continue;
      }
      // Already simulated: a repeat from a peer that is behind us. Nothing to
      // keep, and re-inserting it would leave an entry nobody ever deletes.
      // (Hashes do not travel on frames — `receiveHash` is its own path, so a
      // hash for a tick we have passed is never lost to this skip.)
      if (f.tick < now) continue;
      // The first copy of a frame wins. Frames are immutable once published
      // (`issue`), so a later copy can only ever be identical.
      if (!this.remote.has(f.tick)) this.remote.set(f.tick, f.commands);
    }
    if (rejected) this.rejectedPackets++;
  }

  /** Report the peer's hash for a tick. */
  receiveHash(tick: number, hash: bigint): void {
    // Once halted nothing is compared again, and a claim kept for a tick that
    // will never be reached is a leak.
    if (this.halted) return;
    const own = this.ownHashes.get(tick);
    if (own === undefined) {
      if (!this.hashClaims.some((c) => c.tick === tick)) this.hashClaims.push({ tick, hash });
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
      // Standing still, `publish` has nothing fresh and sends nothing. Resend on
      // a cadence instead of waiting for a tick that cannot come until the peer
      // has what it is missing — which may well be one of our frames.
      this.stallsSinceSend++;
      if (this.stallsSinceSend >= STALL_RESEND_EVERY) this.sendWindow();
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
    this.remote.delete(next);
    // Our own frame stays for as long as it is inside the resend window: the peer
    // may still be waiting on it (see `WINDOW_FRAMES`). After this tick the
    // window starts at `next + 1 - MAX_PEER_LAG_TICKS`, so the frame one below
    // it is the one that has just left; one delete per tick keeps up.
    this.local.delete(next - MAX_PEER_LAG_TICKS);

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
