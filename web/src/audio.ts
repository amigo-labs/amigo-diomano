/**
 * Procedural audio. HANDOFF §7.5, §9.4.
 *
 * Everything is synthesised: no samples, no external assets, no licensing
 * exposure, near-zero repo weight. Two sources:
 *
 * - A **surf bed** whose loudness tracks how much water is moving. It rises as
 *   a tide comes in and falls in the recovery window, so the tide has an
 *   audible telegraph as well as a visual one — useful precisely because §8
 *   forbids a countdown.
 * - **One-shots** for verbs, so an action that takes effect half a second later
 *   still confirms immediately. That matters here more than in most games:
 *   pillar 2 makes input deliberately loosely coupled to visible response, and
 *   sound is the cheapest way to keep that from feeling unresponsive.
 *
 * The render PRNG (noise) never touches simulation state (§4.4).
 */

import type { Sim } from "./main";
import { VERB } from "./main";

export interface Audio {
  resume(): Promise<void>;
  suspend(): Promise<void>;
  sync(sim: Sim, dtMs: number): void;
  /** Confirmation one-shot for an applied verb. `gain` scales it (opponent casts play quieter). */
  gesture(verb: number, gain?: number): void;
  /** Two falling dull pings: the diegetic "no" for a refused or empty cast. */
  refusal(): void;
  /** Earth being worked. Bumped per applied raise/lower, decays in `sync`. */
  sculpt(): void;
  /** Match-end sting. */
  sting(kind: "win" | "loss" | "draw"): void;
}

export function createAudio(): Audio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let surfGain: GainNode | null = null;
  let windGain: GainNode | null = null;
  let sculptGain: GainNode | null = null;
  let smoothedFlow = 0;
  /** Leaky integrator for the sculpt bed: work bumps it, `sync` drains it. */
  let sculptLevel = 0;

  const ensure = (): AudioContext | null => {
    if (ctx) return ctx;
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();

    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    // Surf: pink-ish noise through a band-pass that opens as flow rises.
    const noise = ctx.createBufferSource();
    noise.buffer = makeNoise(ctx, 4);
    noise.loop = true;
    const surfFilter = ctx.createBiquadFilter();
    surfFilter.type = "lowpass";
    surfFilter.frequency.value = 700;
    surfFilter.Q.value = 0.6;
    surfGain = ctx.createGain();
    surfGain.gain.value = 0.0;
    noise.connect(surfFilter).connect(surfGain).connect(master);
    noise.start();

    // Wind: a quieter, higher bed so silence never becomes total. A planet with
    // no ambience reads as a paused game.
    const wind = ctx.createBufferSource();
    wind.buffer = makeNoise(ctx, 4);
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 1400;
    windFilter.Q.value = 0.4;
    windGain = ctx.createGain();
    windGain.gain.value = 0.05;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();

    // Sculpt: the same noise, band-passed low and gated by `sculptLevel`, so
    // continuous terraforming sounds like ground being worked instead of a
    // per-terrace machine gun. Raise/lower had no sound at all before this —
    // 90% of playtime was silent.
    const grind = ctx.createBufferSource();
    grind.buffer = makeNoise(ctx, 4);
    grind.loop = true;
    const grindFilter = ctx.createBiquadFilter();
    grindFilter.type = "bandpass";
    grindFilter.frequency.value = 240;
    grindFilter.Q.value = 0.8;
    sculptGain = ctx.createGain();
    sculptGain.gain.value = 0;
    grind.connect(grindFilter).connect(sculptGain).connect(master);
    grind.start();

    return ctx;
  };

  const ping = (
    frequency: number,
    duration: number,
    type: OscillatorType,
    gainValue: number,
  ): void => {
    const c = ensure();
    if (!c || !master) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, c.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.55, c.currentTime + duration);
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(gainValue, c.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
    osc.connect(gain).connect(master);
    osc.start();
    osc.stop(c.currentTime + duration + 0.02);
  };

  return {
    async resume(): Promise<void> {
      const c = ensure();
      if (c && c.state === "suspended") await c.resume();
    },

    async suspend(): Promise<void> {
      if (ctx && ctx.state === "running") await ctx.suspend();
    },

    sync(sim: Sim, dtMs: number): void {
      if (!ctx || !surfGain || !windGain) return;

      // How much water is in motion, sampled rather than summed: the erosion
      // marker covers 24,576 cells and this runs every frame.
      let flow = 0;
      let n = 0;
      for (let c = 0; c < sim.cells; c += 37) {
        flow += sim.erode[c] ?? 0;
        n += 1;
      }
      const level = n > 0 ? flow / n / 255 : 0;

      // Slew, so a single violent tick does not click.
      const k = 1 - Math.exp(-0.002 * dtMs);
      smoothedFlow += (level - smoothedFlow) * k;

      surfGain.gain.value = Math.min(0.02 + smoothedFlow * 1.6, 0.35);

      // The wind picks up before a wave lands. Same data the atmosphere shader
      // uses for its rim, so picture and sound agree.
      const phase = sim.e.dio_tide_phase();
      const toImpact = sim.e.dio_ticks_to_impact();
      const warning = phase === 1 ? 1 - Math.min(toImpact / 300, 1) : phase === 2 ? 1 : 0;
      windGain.gain.value = 0.04 + warning * 0.22;

      // The sculpt bed drains on its own; a lone terrace step is a scuff, a
      // held drag a steady grind.
      sculptLevel = Math.max(0, sculptLevel - 0.0022 * dtMs);
      if (sculptGain) sculptGain.gain.value = Math.min(sculptLevel, 0.6) * 0.3;
    },

    gesture(verb: number, gain = 1): void {
      switch (verb) {
        case VERB.MAGNET:
          // The only command in the game finally sounds like one: a small
          // bell, root plus a fifth.
          ping(660, 0.35, "sine", 0.2 * gain);
          ping(990, 0.3, "sine", 0.1 * gain);
          break;
        case VERB.VOLCANO:
          ping(70, 1.4, "sawtooth", 0.35 * gain);
          break;
        case VERB.FLOOD:
          ping(120, 1.1, "sine", 0.3 * gain);
          break;
        case VERB.EARTHQUAKE:
          ping(48, 1.6, "square", 0.28 * gain);
          break;
        case VERB.SWAMP:
          ping(190, 0.7, "triangle", 0.22 * gain);
          break;
        case VERB.CHAMPION:
          ping(520, 0.5, "sawtooth", 0.24 * gain);
          break;
        case VERB.ARMAGEDDON:
          ping(38, 3.2, "sawtooth", 0.45 * gain);
          break;
        default:
          ping(320, 0.18, "sine", 0.14 * gain);
      }
    },

    refusal(): void {
      ping(210, 0.09, "triangle", 0.12);
      setTimeout(() => ping(165, 0.11, "triangle", 0.12), 90);
    },

    sculpt(): void {
      ensure();
      sculptLevel = Math.min(sculptLevel + 0.18, 1);
    },

    sting(kind: "win" | "loss" | "draw"): void {
      if (kind === "win") {
        // A rising triad, staggered.
        ping(330, 0.9, "sine", 0.3);
        setTimeout(() => ping(415, 0.9, "sine", 0.3), 220);
        setTimeout(() => ping(495, 1.4, "sine", 0.32), 440);
      } else if (kind === "loss") {
        ping(110, 2.5, "sawtooth", 0.28);
        setTimeout(() => ping(82, 2.2, "sawtooth", 0.2), 500);
      } else {
        ping(220, 1.6, "sine", 0.24);
      }
    },
  };
}

/** `seconds` of white noise, generated once and looped. */
function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
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
