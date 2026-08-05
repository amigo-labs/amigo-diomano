/**
 * Command frames — the only thing that ever crosses the wire (HANDOFF §6.1).
 *
 * A frame is a tick number plus the commands issued for that tick. Deterministic
 * lockstep means state is never sent: both peers run the same simulation over the
 * same inputs, so inputs are all there is to agree on.
 *
 * The command encoding here is not a new format. It is `Command::encode` from
 * `crates/diomano-sim/src/world.rs` — the same 8 bytes, the same bit layout,
 * documented in `docs/specs/verbs.md`. Two encoders for one wire format is a
 * desync waiting to happen, so `frame::the_codec_matches_the_rust_layout` in
 * `netcode.test.ts` pins these against vectors produced by the Rust side.
 */

/** A single player command. Mirrors `world::Command`. */
export interface Command {
  tick: number;
  player: number;
  verb: number;
  face: number;
  x: number;
  y: number;
  modifier: number;
}

/** One tick's worth of input from one peer. */
export interface Frame {
  tick: number;
  commands: Command[];
}

export const COMMAND_BYTES = 8;

/** `tick` (u32) + `count` (u16) + `flags` (u16). */
export const FRAME_HEADER_BYTES = 8;

/**
 * Set when this frame is the last of a batch, so a receiver can tell "two frames
 * arrived together" from "two packets arrived at once". Batching is a bandwidth
 * decision (§6.6: 8 bytes of payload inside a ~100 byte packet), not a semantic
 * one, and the loop below must behave identically either way.
 */
export const FLAG_BATCH_END = 1;

/**
 * Pack one command into 8 bytes.
 *
 * Bit layout, verbatim from `Command::encode`: verb 0–3, player 4–5, face 6–8,
 * modifier 9–14, x 15–23, y 24–32, tick 33–63, little-endian.
 *
 * Written as two 32-bit halves rather than a `BigInt`: the field at bits 24–32
 * straddles the boundary, and doing that by hand is the part worth being explicit
 * about. `BigInt` would be correct and allocate on every command, 30 times a
 * second, forever.
 */
export function encodeCommand(c: Command, out: DataView, offset: number): void {
  const lo =
    ((c.verb & 0xf) |
      ((c.player & 0x3) << 4) |
      ((c.face & 0x7) << 6) |
      ((c.modifier & 0x3f) << 9) |
      ((c.x & 0x1ff) << 15) |
      // Only bits 24–31 of `y` fit in the low word; bit 8 of `y` goes to the high
      // word below.
      ((c.y & 0xff) << 24)) >>>
    0;
  const hi =
    (((c.y >>> 8) & 0x1) |
      // `tick` starts at bit 33, i.e. bit 1 of the high word.
      ((c.tick & 0x7fffffff) << 1)) >>>
    0;
  out.setUint32(offset, lo, true);
  out.setUint32(offset + 4, hi, true);
}

export function decodeCommand(view: DataView, offset: number): Command {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return {
    verb: lo & 0xf,
    player: (lo >>> 4) & 0x3,
    face: (lo >>> 6) & 0x7,
    modifier: (lo >>> 9) & 0x3f,
    x: (lo >>> 15) & 0x1ff,
    y: ((lo >>> 24) & 0xff) | ((hi & 0x1) << 8),
    // `>>> 1` then mask: the tick occupies bits 1–31 of the high word.
    tick: (hi >>> 1) & 0x7fffffff,
  };
}

/**
 * Serialise one or more frames into a single packet.
 *
 * Empty frames are included, always. A peer that has nothing to say still says so
 * every tick, which is the only way "silent" is distinguishable from "stalled"
 * (§6.1) — and telling those apart is the difference between waiting and halting.
 */
export function encodeFrames(frames: Frame[]): Uint8Array {
  let bytes = 0;
  for (const f of frames) bytes += FRAME_HEADER_BYTES + f.commands.length * COMMAND_BYTES;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  let o = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f === undefined) continue;
    view.setUint32(o, f.tick, true);
    view.setUint16(o + 4, f.commands.length, true);
    view.setUint16(o + 6, i === frames.length - 1 ? FLAG_BATCH_END : 0, true);
    o += FRAME_HEADER_BYTES;
    for (const c of f.commands) {
      encodeCommand(c, view, o);
      o += COMMAND_BYTES;
    }
  }
  return new Uint8Array(buf);
}

export function decodeFrames(packet: Uint8Array): Frame[] {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const frames: Frame[] = [];
  let o = 0;
  while (o + FRAME_HEADER_BYTES <= packet.byteLength) {
    const tick = view.getUint32(o, true);
    const count = view.getUint16(o + 4, true);
    o += FRAME_HEADER_BYTES;
    if (o + count * COMMAND_BYTES > packet.byteLength) {
      throw new Error(`truncated frame at tick ${tick}: wanted ${count} commands`);
    }
    const commands: Command[] = [];
    for (let i = 0; i < count; i++) {
      commands.push(decodeCommand(view, o));
      o += COMMAND_BYTES;
    }
    frames.push({ tick, commands });
  }
  return frames;
}
