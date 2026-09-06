/**
 * The beds: what the planet sounds like where you are looking at it.
 *
 * Five looped noise sources, each through its own filter and gain, and the
 * gains follow the simulation *under the camera*: surf where water is moving,
 * forest where vegetation stands, crackle where lava lies, wind that picks up
 * as the camera pulls out to orbit and before a wave lands, and the grind of
 * ground being worked, which changes its voice with the material under the
 * hand. Nothing here is a sample and nothing here is random in a way the
 * simulation could see (§10) — the one noise buffer is shared, and the levels
 * are functions of simulation data plus the camera.
 *
 * # Sampled, not summed
 *
 * The look-at cell is found once per tick by casting the view ray onto the
 * planet, and a window of 9 x 9 cells at a stride of four around it is read.
 * Eighty-one reads a tick is nothing; what it buys is that the same forest is
 * loud when you are over it and gone when you orbit away, which is the whole
 * difference between ambience and a loop.
 */

import * as THREE from "three";
import type { Sim } from "../main";
import { WARNING_RAMP_TICKS } from "../renderer/atmosphere";
import { pickCell } from "../renderer/planet";
import { HAND_MATERIAL } from "../verbs";
import type { Synth } from "./synth";

/** The materials the sim knows, as `material[c]` holds them. */
const MAT = { rock: 0, sand: 1, soil: 2, ash: 3, swamp: 4 } as const;

/** Camera range, mirroring `camera.ts`, for the orbit wind. */
const MIN_DISTANCE = 1.35;
const MAX_DISTANCE = 4.2;

export interface Ambience {
  /** Once per frame. `tick` gates the sampling; `dtMs` drives the slew. */
  sync(sim: Sim, camera: THREE.PerspectiveCamera, tick: number, dtMs: number): void;
  /** Earth being worked at a cell: bumps the grind and tunes it to the material. */
  sculpt(material: number, handMaterial: number): void;
}

interface Bed {
  filter: BiquadFilterNode;
  gain: GainNode;
}

export function createAmbience(synth: Synth): Ambience {
  const { ctx, master, noise } = synth;

  const bed = (type: BiquadFilterType, frequency: number, q: number, offset: number): Bed => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    // Each bed starts at its own point in the buffer, so five copies of one
    // noise do not phase into a single louder one.
    src.start(0, offset);
    return { filter, gain };
  };

  // Surf: low and broad. Wind: higher and thin, never silent — a planet with
  // no ambience reads as a paused game. Forest: the rustle band. Lava: the
  // crackle band, driven by bursts below. Grind: retuned per material.
  const surf = bed("lowpass", 700, 0.6, 0.0);
  const wind = bed("bandpass", 1400, 0.4, 0.8);
  const forest = bed("bandpass", 2600, 0.5, 1.6);
  const lava = bed("highpass", 1800, 0.7, 2.4);
  const grind = bed("bandpass", 240, 0.8, 3.2);
  wind.gain.gain.value = 0.05;

  // A slow swell on the forest, so leaves move rather than hiss.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.17;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0;
  lfo.connect(lfoDepth).connect(forest.gain.gain);
  lfo.start();

  // Levels as sampled at the last tick, and their slewed versions.
  let sampledAt = -1;
  let surfLocal = 0;
  let surfGlobal = 0;
  let forestLevel = 0;
  let lavaLevel = 0;
  let smoothedSurf = 0;
  let smoothedForest = 0;
  let smoothedLava = 0;
  /** Leaky integrator for the grind: work bumps it, `sync` drains it. */
  let sculptLevel = 0;
  // A render-side LCG for the lava crackle. Never the simulation's (§10).
  let crackleSeed = 0x9e3779b9;

  const eye = { x: 0, y: 0, z: 0 };

  /** Read the world around the look-at point. Once per tick. */
  const sample = (sim: Sim, camera: THREE.PerspectiveCamera): void => {
    // The view ray against the unit sphere; if it misses, the nearest point.
    const o = camera.position;
    const d = camera.getWorldDirection(scratchDir);
    const b = o.dot(d);
    const c = o.lengthSq() - 1.0;
    const disc = b * b - c;
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      eye.x = o.x + d.x * t;
      eye.y = o.y + d.y * t;
      eye.z = o.z + d.z * t;
    } else {
      eye.x = o.x;
      eye.y = o.y;
      eye.z = o.z;
    }
    scratchDir.set(eye.x, eye.y, eye.z);
    const cell = pickCell(scratchDir, sim.N);
    const sea = sim.e.dio_sea_level();

    let veg = 0;
    let lavaSum = 0;
    let erodeSum = 0;
    let n = 0;
    // The window is clamped to the face the look-at cell is on rather than
    // walked across the seam: near a face edge it reads the edge cells twice
    // instead of the neighbouring face. For a smoothed ambience level that is
    // a small bias, and the seam arithmetic lives in `world.rs` alone.
    for (let dy = -16; dy <= 16; dy += 4) {
      for (let dx = -16; dx <= 16; dx += 4) {
        const x = Math.min(sim.N - 1, Math.max(0, cell.x + dx));
        const y = Math.min(sim.N - 1, Math.max(0, cell.y + dy));
        const i = sim.idx(cell.face, x, y);
        n += 1;
        if ((sim.height[i] ?? 0) > sea && (sim.vegetation[i] ?? 0) >= 40) veg += 1;
        lavaSum += sim.lava[i] ?? 0;
        erodeSum += sim.erode[i] ?? 0;
      }
    }
    forestLevel = veg / n;
    lavaLevel = Math.min(1, lavaSum / (n * 40));
    surfLocal = erodeSum / n / 255;

    // The global figure the surf used to be driven by alone, kept as a floor:
    // a tide is planet-wide and should be audible from orbit too.
    let flow = 0;
    let m = 0;
    for (let i = 0; i < sim.cells; i += 37) {
      flow += sim.erode[i] ?? 0;
      m += 1;
    }
    surfGlobal = m > 0 ? flow / m / 255 : 0;
  };

  return {
    sync(sim, camera, tick, dtMs): void {
      if (tick !== sampledAt) {
        sampledAt = tick;
        sample(sim, camera);
      }
      const k = 1 - Math.exp(-0.002 * dtMs);
      const surfTarget = Math.max(surfGlobal, surfLocal * 1.6);
      smoothedSurf += (surfTarget - smoothedSurf) * k;
      smoothedForest += (forestLevel - smoothedForest) * k;
      smoothedLava += (lavaLevel - smoothedLava) * k * 2;

      const now = ctx.currentTime;
      surf.gain.gain.value = Math.min(0.02 + smoothedSurf * 1.6, 0.35);

      // The wind picks up before a wave lands — the same data the atmosphere
      // shader uses for its rim, so picture and sound agree — and as the camera
      // pulls out: from the ground the air is still, from orbit it is all there is.
      const phase = sim.e.dio_tide_phase();
      const toImpact = sim.e.dio_ticks_to_impact();
      const warning =
        phase === 1 ? 1 - Math.min(toImpact / WARNING_RAMP_TICKS, 1) : phase === 2 ? 1 : 0;
      const distance = camera.position.length();
      const orbit = Math.max(
        0,
        Math.min(1, (distance - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE)),
      );
      wind.gain.gain.value = 0.025 + orbit * 0.06 + warning * 0.22;

      // Forest, swelling on the LFO; quieter from orbit, where a forest is a
      // colour and not a place.
      const forestGain = smoothedForest * 0.07 * (1 - orbit * 0.7);
      forest.gain.gain.value = forestGain;
      lfoDepth.gain.value = forestGain * 0.45;

      // Lava crackles: the bed is gated by bursts whose density follows how
      // much lava is in view. `setTargetAtTime` rounds the burst edges.
      if (smoothedLava > 0.002) {
        crackleSeed = (crackleSeed * 1664525 + 1013904223) >>> 0;
        const r = crackleSeed / 4294967296;
        const burst = r < 0.08 + smoothedLava * 0.3 ? 0.5 + r * 4 : 0.12;
        lava.gain.gain.setTargetAtTime(smoothedLava * 0.16 * burst, now, 0.012);
      } else {
        lava.gain.gain.setTargetAtTime(0, now, 0.05);
      }

      // The grind drains on its own; a lone terrace step is a scuff, a held
      // drag a steady grind.
      sculptLevel = Math.max(0, sculptLevel - 0.0022 * dtMs);
      grind.gain.gain.value = Math.min(sculptLevel, 0.6) * 0.3;
    },

    sculpt(material, handMaterial): void {
      sculptLevel = Math.min(sculptLevel + 0.18, 1);
      // What the hand is moving decides the voice: sand hisses, rock grinds,
      // soil and ash rustle, water sloshes in a resonant band, lava gargles.
      let frequency = 240;
      let q = 0.8;
      if (handMaterial === HAND_MATERIAL.WATER) {
        frequency = 380;
        q = 2.2;
      } else if (handMaterial === HAND_MATERIAL.LAVA) {
        frequency = 160;
        q = 1.6;
      } else if (material === MAT.sand) {
        frequency = 1500;
        q = 0.6;
      } else if (material === MAT.soil || material === MAT.ash || material === MAT.swamp) {
        frequency = 420;
        q = 0.7;
      }
      const now = ctx.currentTime;
      grind.filter.frequency.setTargetAtTime(frequency, now, 0.05);
      grind.filter.Q.setTargetAtTime(q, now, 0.05);
    },
  };
}

/** Scratch for the view ray. Module-level: `sync` runs every frame. */
const scratchDir = new THREE.Vector3();
