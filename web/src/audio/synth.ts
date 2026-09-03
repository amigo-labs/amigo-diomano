/**
 * The synthesiser: everything that makes a sound out of nothing.
 *
 * HANDOFF §7.5 — no samples, no assets. What is here is a signal chain, a
 * noise buffer, a generated room, and one function, `voice`, that every
 * one-shot in the game is a call to. It replaced a `ping` that was one
 * oscillator with a pitch drop: a volcano and a bell were the same sound at
 * different frequencies, and neither had a place in the stereo field.
 *
 * # The chain
 *
 * ```
 * voice ──┬── panner ── master ── compressor ── destination
 *         └── send ─── convolver ── return ──┘
 * ```
 *
 * The compressor is a limiter in all but name. Layered voices — a sub tone, a
 * rumble and a hiss for one eruption — add up, and clipping is the one
 * failure a procedural mix can produce that no listener forgives. The room is
 * a convolution with an impulse *generated* from the same noise the surf is
 * made of: exponentially decaying, slightly different in each ear, about a
 * second and a half. It is what makes a bell ring in a place rather than in a
 * headphone.
 *
 * # Position
 *
 * A voice may be given a cell. It is panned by where that cell sits in the
 * camera's view and quietened as it leaves the centre of it or crosses to the
 * far side of the planet, so the opponent's volcano is heard *over there*, and
 * an earthquake under the hand is heard here. The math is in `spatialise`.
 */

import * as THREE from "three";
import { cellDirectionInto } from "../renderer/planet";

/** Where a sound comes from, in simulation cells. */
export interface At {
  face: number;
  x: number;
  y: number;
}

/** A shaped source. Everything optional but the pitch or the noise. */
export interface Voice {
  /** Oscillator frequency in Hz; omit for a noise-only voice. */
  freq?: number;
  /** Where the frequency ramps to by the end of the decay. Defaults to `freq`. */
  freqEnd?: number;
  type?: OscillatorType;
  /** Peak gain, linear. */
  gain: number;
  /** Envelope, seconds. `attack` to the peak, `decay` to silence. */
  attack?: number;
  decay: number;
  /** Delay before the voice starts, seconds. Layers are staggered with it. */
  delay?: number;
  /** A filter on the way out, sweeping from `from` to `to` over the decay. */
  filter?: { type: BiquadFilterType; from: number; to?: number; q?: number };
  /** Add the shared noise buffer as the source, instead of or as well as the oscillator. */
  noise?: boolean;
  /** How much goes to the room, 0..1. */
  send?: number;
  /** Position, or none for a sound with no place (the player's own refusal). */
  at?: At;
}

export interface Synth {
  readonly ctx: AudioContext;
  /** Everything a bed connects to: the mix before the limiter. */
  readonly master: GainNode;
  /** The shared 4-second pink noise buffer, for beds. */
  readonly noise: AudioBuffer;
  /** Play one shaped source. Returns immediately; the graph tears itself down. */
  voice(v: Voice): void;
  /** Pan and attenuation for a cell in the current view. */
  spatialise(at: At): { pan: number; gain: number };
  /** Tell the synth where the camera is. Once per frame. */
  view(camera: THREE.PerspectiveCamera, cells: number): void;
}

/** The whole planet fits in the view at 4.2 radii; nothing is nearer than 1.35. */
const PLANET_RADIUS = 1.0;

export function createSynth(ctx: AudioContext, destination: AudioNode): Synth {
  const master = ctx.createGain();
  master.gain.value = 1;

  // A limiter: hard knee, high ratio, fast. It should never be heard working,
  // which is the point of having it.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.18;
  master.connect(limiter).connect(destination);

  const noise = makeNoise(ctx, 4);

  // The room. A generated impulse: decaying noise, stereo by giving each ear
  // its own sequence, with the high end rolling off as it decays so it reads
  // as air and stone rather than as a hiss.
  const room = ctx.createConvolver();
  room.buffer = makeImpulse(ctx, 1.5);
  const roomReturn = ctx.createGain();
  roomReturn.gain.value = 0.32;
  room.connect(roomReturn).connect(master);

  // View state for `spatialise`, refreshed by `view`.
  let N = 64;
  const viewInverse = new Float64Array(16).fill(0);
  let haveView = false;
  const dir = { x: 0, y: 0, z: 0 };
  const tmp = new Float64Array(3);
  /** Unit vector from the planet's centre toward the camera. */
  const viewFrom = { x: 0, y: 0, z: 1 };

  const spatialise = (at: At): { pan: number; gain: number } => {
    if (!haveView) return { pan: 0, gain: 1 };
    const v = vecInto(dir, at, N);
    // World point on the surface, then into view space through the inverse
    // camera matrix (column-major, as three stores it).
    const px = v.x * PLANET_RADIUS;
    const py = v.y * PLANET_RADIUS;
    const pz = v.z * PLANET_RADIUS;
    const m = viewInverse;
    tmp[0] = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
    tmp[1] = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
    tmp[2] = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
    const len = Math.hypot(tmp[0]!, tmp[1]!, tmp[2]!) || 1;
    // Pan by the horizontal angle off the view axis, kept off the extremes so
    // a sound at the edge of the frame is still in both ears.
    const pan = Math.max(-0.85, Math.min(0.85, (tmp[0]! / len) * 1.4));
    // How central: 1 dead ahead, falling as it leaves the frame.
    const forward = -tmp[2]! / len;
    const focus = Math.max(0, Math.min(1, (forward - 0.55) / 0.45));
    // The far side of the planet is behind a planet.
    const facing = v.x * viewFrom.x + v.y * viewFrom.y + v.z * viewFrom.z;
    const occluded = facing < 0 ? 0.35 : 1;
    return { pan, gain: (0.3 + 0.7 * focus * focus) * occluded };
  };

  const voice = (v: Voice): void => {
    const t0 = ctx.currentTime + (v.delay ?? 0);
    const attack = Math.max(0.003, v.attack ?? 0.008);
    const end = t0 + attack + v.decay;
    const where = v.at ? spatialise(v.at) : { pan: 0, gain: 1 };
    const peak = Math.max(0.0002, v.gain * where.gain);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);

    let out: AudioNode = env;
    if (v.filter) {
      const f = ctx.createBiquadFilter();
      f.type = v.filter.type;
      f.Q.value = v.filter.q ?? 0.7;
      f.frequency.setValueAtTime(v.filter.from, t0);
      if (v.filter.to !== undefined)
        f.frequency.exponentialRampToValueAtTime(Math.max(20, v.filter.to), end);
      env.connect(f);
      out = f;
    }
    const pan = ctx.createStereoPanner();
    pan.pan.value = where.pan;
    out.connect(pan).connect(master);
    if (v.send) {
      const send = ctx.createGain();
      send.gain.value = v.send;
      out.connect(send).connect(room);
    }

    if (v.freq !== undefined) {
      const osc = ctx.createOscillator();
      osc.type = v.type ?? "sine";
      osc.frequency.setValueAtTime(v.freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.freqEnd ?? v.freq), end);
      osc.connect(env);
      osc.start(t0);
      osc.stop(end + 0.02);
    }
    if (v.noise) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      // A different stretch of the buffer each time, so two bursts in a row
      // are not the same burst.
      src.connect(env);
      src.start(t0, (t0 * 7.31) % 3.5);
      src.stop(end + 0.02);
    }
  };

  return {
    ctx,
    master,
    noise,
    voice,
    spatialise,
    view(camera, cells): void {
      N = Math.round(Math.sqrt(cells / 6));
      const e = camera.matrixWorldInverse.elements;
      for (let i = 0; i < 16; i++) viewInverse[i] = e[i] ?? 0;
      const p = camera.position;
      const l = p.length() || 1;
      viewFrom.x = p.x / l;
      viewFrom.y = p.y / l;
      viewFrom.z = p.z / l;
      haveView = true;
    },
  };
}

/** Scratch for `cellDirectionInto`; hoisted, this runs per one-shot. */
const scratch = new THREE.Vector3();
function vecInto(out: { x: number; y: number; z: number }, at: At, N: number) {
  cellDirectionInto(scratch, at.face, at.x + 0.5, at.y + 0.5, N);
  out.x = scratch.x;
  out.y = scratch.y;
  out.z = scratch.z;
  return out;
}

/** `seconds` of pink-ish noise, generated once and looped. */
export function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A separate, unconstrained render PRNG. It must never touch simulation
  // state, so it is a local LCG rather than anything the sim can see (§4.4).
  let s = 0x13572468;
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const white = s / 2147483648 - 1;
    // Two one-pole filters approximate pink noise, which sits behind a scene
    // instead of hissing over it.
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    data[i] = (b0 + b1 + white * 0.1848) * 0.28;
  }
  return buffer;
}

/**
 * A room's impulse response: noise that decays exponentially and darkens as it
 * goes, a different sequence in each ear. `seconds` is roughly the RT60.
 */
function makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let s = ch === 0 ? 0x2468ace1 : 0x13579bdf;
    let lp = 0;
    for (let i = 0; i < length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const white = s / 2147483648 - 1;
      const t = i / length;
      // The low-pass tightens as the tail decays: late reflections are duller.
      const k = 0.2 + t * 0.6;
      lp += (white - lp) * (1 - k);
      // -60 dB at the end, with a short pre-ramp so the direct sound is not doubled.
      const early = Math.min(1, i / (ctx.sampleRate * 0.01));
      data[i] = lp * early * Math.exp(-6.9 * t) * 0.5;
    }
  }
  return buffer;
}
