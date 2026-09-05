/**
 * Procedural audio. HANDOFF §7.5, §9.4.
 *
 * Everything is synthesised: no samples, no external assets, no licensing
 * exposure, near-zero repo weight. Four parts, each its own file:
 *
 * - `synth.ts` — the chain (limiter, generated room), and `voice`, the one
 *   shaped source every one-shot is made of, panned by where its cell sits in
 *   the camera's view.
 * - `ambience.ts` — the beds. Surf, wind, forest, lava crackle and the grind
 *   of ground being worked, driven by the simulation *under the camera* and by
 *   how far out the camera is.
 * - `events.ts` — what the population does: fighting, founding, rising,
 *   falling, read off the census counters and the settlement slots.
 * - this file — the verbs, the refusal, the stings, and the volume.
 *
 * One-shots for verbs matter here more than in most games: pillar 2 makes
 * input deliberately loosely coupled to visible response, and sound is the
 * cheapest way to keep that from feeling unresponsive. An action that takes
 * effect half a second later still confirms immediately — and now confirms
 * *where*, so the other god's powers are heard on their side of the planet.
 *
 * The render PRNG (noise) never touches simulation state (§4.4, §10).
 *
 * # Volume
 *
 * The master gain was a hard-coded 0.5 with no way to reach it. It is
 * settable, mutable and remembered in `localStorage`, and the desired value is
 * held here rather than on the node, because the `AudioContext` is created
 * lazily on the first sound: a change made from the title card happens
 * *before* there is a gain node to write to.
 */

import type * as THREE from "three";
import type { Sim, VerbEventView } from "../main";
import { DEFAULT_VOLUME, KEY, remember, rememberedFlag, rememberedLevel } from "../storage";
import { VERB } from "../verbs";
import { type Ambience, createAmbience } from "./ambience";
import { type Events, createEvents } from "./events";
import { type At, type Synth, createSynth } from "./synth";

export interface Audio {
  resume(): Promise<void>;
  suspend(): Promise<void>;
  /** Once per frame: beds, the view for panning, and the per-tick event diff. */
  sync(sim: Sim, camera: THREE.PerspectiveCamera, dtMs: number): void;
  /**
   * One-shot for an applied verb — the player's own or, quieter, the
   * opponent's. With the event, it is placed where the verb landed.
   */
  verbSfx(verb: number, gain?: number, at?: Pick<VerbEventView, "face" | "x" | "y">): void;
  /** Two falling dull pings: the diegetic "no" for a refused or empty cast. */
  refusal(): void;
  /** Earth being worked. Bumped per applied raise/lower, tuned to what moved. */
  sculpt(material: number, handMaterial: number): void;
  /** Match-end sting. */
  sting(kind: "win" | "loss" | "draw"): void;
  /** Forget the match's tick-stamped state, for a restart. */
  reset(): void;
  /** Master volume, 0..1. Unaffected by mute — this is the remembered level. */
  volume(): number;
  /** Set master volume, 0..1. Persisted, and unmutes if it is *raised*. */
  setVolume(v: number): void;
  /** Flip mute. Returns the new state. Persisted. */
  toggleMute(): boolean;
  /** Whether sound is currently muted. */
  muted(): boolean;
}

export function createAudio(localPlayer = 0): Audio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let synth: Synth | null = null;
  let ambience: Ambience | null = null;
  let events: Events | null = null;
  let volume = rememberedLevel(KEY.volume, DEFAULT_VOLUME);
  let isMuted = rememberedFlag(KEY.muted, false);
  let lastEventTick = -1;

  /** Push `volume`/`isMuted` at the gain node, if one exists yet. */
  const applyGain = (): void => {
    if (master) master.gain.value = isMuted ? 0 : volume;
  };

  const ensure = (): Synth | null => {
    if (synth) return synth;
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.connect(ctx.destination);
    // Whatever was chosen before the context existed applies from the first
    // sample, so the title card's slider is not silently ignored.
    applyGain();
    synth = createSynth(ctx, master);
    ambience = createAmbience(synth);
    events = createEvents(synth);
    return synth;
  };

  const place = (at?: Pick<VerbEventView, "face" | "x" | "y">): { at?: At } =>
    at ? { at: { face: at.face, x: at.x, y: at.y } } : {};

  return {
    async resume(): Promise<void> {
      ensure();
      if (ctx && ctx.state === "suspended") await ctx.resume();
    },

    async suspend(): Promise<void> {
      if (ctx && ctx.state === "running") await ctx.suspend();
    },

    sync(sim, camera, dtMs): void {
      if (!synth || !ambience || !events) return;
      synth.view(camera, sim.N);
      const tick = sim.e.dio_tick_count();
      ambience.sync(sim, camera, tick, dtMs);
      if (tick !== lastEventTick) {
        lastEventTick = tick;
        events.sync(sim, tick, localPlayer);
      }
    },

    verbSfx(verb, gainIn, at): void {
      const s = ensure();
      if (!s) return;
      const gain = gainIn ?? 1;
      const p = place(at);
      switch (verb) {
        case VERB.MAGNET:
          // The only command in the game sounds like one: a bell, with the
          // partials a bell has, in a room.
          s.voice({ freq: 660, gain: 0.18 * gain, decay: 0.9, send: 0.6, ...p });
          s.voice({ freq: 660 * 2.76, gain: 0.07 * gain, decay: 0.55, send: 0.6, ...p });
          s.voice({ freq: 660 * 5.4, gain: 0.03 * gain, decay: 0.3, send: 0.6, ...p });
          break;
        case VERB.VOLCANO:
          // A sub tone, a rumble that darkens, and the hiss of gas over it.
          s.voice({ freq: 45, freqEnd: 28, gain: 0.34 * gain, attack: 0.05, decay: 1.6, ...p });
          s.voice({
            noise: true,
            gain: 0.28 * gain,
            attack: 0.08,
            decay: 1.6,
            filter: { type: "lowpass", from: 420, to: 110, q: 0.9 },
            send: 0.3,
            ...p,
          });
          s.voice({
            noise: true,
            gain: 0.07 * gain,
            attack: 0.02,
            decay: 0.7,
            delay: 0.1,
            filter: { type: "bandpass", from: 2200, to: 1400, q: 0.8 },
            ...p,
          });
          break;
        case VERB.FLOOD:
          // Water arriving: a swell of noise rising through the band, over a
          // low wave.
          s.voice({
            noise: true,
            gain: 0.24 * gain,
            attack: 0.35,
            decay: 1.0,
            filter: { type: "bandpass", from: 320, to: 1300, q: 0.7 },
            send: 0.35,
            ...p,
          });
          s.voice({ freq: 120, freqEnd: 75, gain: 0.2 * gain, attack: 0.1, decay: 1.1, ...p });
          break;
        case VERB.EARTHQUAKE:
          // The ground itself: a sub square, a rumble, and two thuds as it settles.
          s.voice({
            freq: 48,
            freqEnd: 30,
            type: "square",
            gain: 0.22 * gain,
            decay: 1.6,
            filter: { type: "lowpass", from: 180 },
            ...p,
          });
          s.voice({
            noise: true,
            gain: 0.26 * gain,
            attack: 0.03,
            decay: 1.5,
            filter: { type: "lowpass", from: 220, to: 90, q: 0.8 },
            ...p,
          });
          s.voice({ freq: 70, freqEnd: 45, gain: 0.18 * gain, decay: 0.16, delay: 0.3, ...p });
          s.voice({ freq: 62, freqEnd: 40, gain: 0.14 * gain, decay: 0.16, delay: 0.58, ...p });
          break;
        case VERB.SWAMP:
          // Bubbles: a run of short blips over a wet noise floor.
          s.voice({
            noise: true,
            gain: 0.1 * gain,
            attack: 0.05,
            decay: 0.7,
            filter: { type: "lowpass", from: 520, q: 0.7 },
            ...p,
          });
          for (let i = 0; i < 5; i++) {
            const f = 180 + ((i * 97) % 5) * 34;
            s.voice({
              freq: f,
              freqEnd: f * 1.6,
              gain: 0.09 * gain,
              decay: 0.11,
              delay: 0.04 + i * 0.09,
              ...p,
            });
          }
          break;
        case VERB.CHAMPION:
          // A brass chord, the fifth and the octave swelling in under the root.
          s.voice({
            freq: 520,
            freqEnd: 528,
            type: "sawtooth",
            gain: 0.1 * gain,
            attack: 0.04,
            decay: 0.6,
            filter: { type: "lowpass", from: 1900, to: 1200 },
            send: 0.4,
            ...p,
          });
          s.voice({
            freq: 780,
            freqEnd: 786,
            type: "sawtooth",
            gain: 0.07 * gain,
            attack: 0.09,
            decay: 0.55,
            filter: { type: "lowpass", from: 1900, to: 1200 },
            send: 0.4,
            ...p,
          });
          s.voice({
            freq: 1040,
            type: "sawtooth",
            gain: 0.04 * gain,
            attack: 0.14,
            decay: 0.5,
            filter: { type: "lowpass", from: 2400, to: 1400 },
            send: 0.4,
            ...p,
          });
          break;
        case VERB.ARMAGEDDON:
          // The end of things: a sub that falls out of hearing, a roar, and a toll.
          s.voice({
            freq: 38,
            freqEnd: 18,
            type: "sawtooth",
            gain: 0.34 * gain,
            attack: 0.1,
            decay: 3.2,
            filter: { type: "lowpass", from: 140, to: 60 },
            ...p,
          });
          s.voice({
            noise: true,
            gain: 0.3 * gain,
            attack: 0.3,
            decay: 3.0,
            filter: { type: "lowpass", from: 900, to: 140, q: 0.9 },
            send: 0.5,
            ...p,
          });
          s.voice({ freq: 220, gain: 0.16 * gain, decay: 2.2, delay: 0.4, send: 0.7, ...p });
          s.voice({ freq: 220 * 2.76, gain: 0.05 * gain, decay: 1.2, delay: 0.4, send: 0.7, ...p });
          break;
        default:
          s.voice({ freq: 320, freqEnd: 176, gain: 0.14 * gain, decay: 0.18, ...p });
      }
    },

    refusal(): void {
      const s = ensure();
      if (!s) return;
      // Two falling dull pings, and the dry click of a latch that did not open.
      s.voice({ freq: 210, freqEnd: 190, type: "triangle", gain: 0.12, decay: 0.09 });
      s.voice({ freq: 165, freqEnd: 150, type: "triangle", gain: 0.12, decay: 0.11, delay: 0.09 });
      s.voice({ noise: true, gain: 0.04, decay: 0.03, filter: { type: "highpass", from: 3000 } });
    },

    sculpt(material, handMaterial): void {
      ensure();
      ambience?.sculpt(material, handMaterial);
    },

    volume: () => volume,

    setVolume(v: number): void {
      const previous = volume;
      volume = Math.min(Math.max(v, 0), 1);
      // Raising the slider is an unambiguous "I want to hear this", so it lifts
      // mute rather than leaving the player dragging a control that does nothing.
      // Lowering it is not: `M` then `-` used to come back on at the new level.
      if (volume > previous) isMuted = false;
      remember(KEY.volume, String(volume));
      remember(KEY.muted, isMuted ? "1" : "0");
      applyGain();
    },

    toggleMute(): boolean {
      isMuted = !isMuted;
      remember(KEY.muted, isMuted ? "1" : "0");
      applyGain();
      return isMuted;
    },

    muted: () => isMuted,

    reset(): void {
      events?.reset();
      lastEventTick = -1;
    },

    sting(kind): void {
      const s = ensure();
      if (!s) return;
      if (kind === "win") {
        // A rising triad, staggered, each note left ringing in the room.
        s.voice({ freq: 330, gain: 0.26, decay: 1.0, send: 0.6 });
        s.voice({ freq: 415, gain: 0.26, decay: 1.0, delay: 0.22, send: 0.6 });
        s.voice({ freq: 495, gain: 0.28, decay: 1.6, delay: 0.44, send: 0.6 });
        s.voice({ freq: 990, gain: 0.06, decay: 1.4, delay: 0.44, send: 0.6 });
      } else if (kind === "loss") {
        s.voice({
          freq: 110,
          freqEnd: 82,
          type: "sawtooth",
          gain: 0.24,
          decay: 2.5,
          filter: { type: "lowpass", from: 900, to: 300 },
          send: 0.4,
        });
        s.voice({
          freq: 82,
          freqEnd: 60,
          type: "sawtooth",
          gain: 0.18,
          decay: 2.2,
          delay: 0.5,
          filter: { type: "lowpass", from: 700, to: 200 },
          send: 0.4,
        });
      } else {
        s.voice({ freq: 220, gain: 0.22, decay: 1.6, send: 0.5 });
        s.voice({ freq: 220 * 1.5, gain: 0.08, decay: 1.2, delay: 0.1, send: 0.5 });
      }
    },
  };
}
