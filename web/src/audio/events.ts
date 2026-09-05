/**
 * Sounds for what the *population* does: fighting, founding, rising, falling.
 *
 * The client sees its own commands and the applied-verb ring, and nothing
 * else about what happened in a tick. So this reads the state that is already
 * exported — the diagnostic census counters, the walker and settlement views —
 * and diffs it tick to tick. Combat is the count of resolutions going up;
 * where it happened is found by looking for the cell where walkers of both
 * gods stand. A settlement is founded when a slot appears, rises when its tier
 * does, falls when its slot goes dark.
 *
 * None of it feeds back. The census is write-only from the simulation's point
 * of view and stays so; this only reads it (§10).
 */

import type { Sim } from "../main";
import type { At, Synth } from "./synth";

/** Fewest ticks between two clash sounds. Six a second is a battle; thirty is a buzz. */
const CLASH_COOLDOWN_TICKS = 5;

interface Known {
  tier: number;
  owner: number;
  face: number;
  x: number;
  y: number;
}

export interface Events {
  /** Once per tick, after the simulation advanced. */
  sync(sim: Sim, tick: number, localPlayer: number): void;
  /** Forget the match, for a restart: the tick counter is about to go back to zero. */
  reset(): void;
}

export function createEvents(synth: Synth): Events {
  let lastCombat = -1;
  let lastMerges = -1;
  let lastClash = -1_000;
  let lastMerge = -1_000;
  const known = new Map<number, Known>();
  const seen = new Set<number>();
  /** Cell → bitmask of owners with a walker on it, rebuilt when combat rose. */
  const occupants = new Map<number, number>();

  const clash = (at: At | undefined, strength: number): void => {
    // Steel: a bright noise burst with a ringing metallic partial under it,
    // and a duller thud for the bodies.
    const g = 0.5 + 0.5 * strength;
    synth.voice({
      noise: true,
      gain: 0.14 * g,
      decay: 0.07,
      filter: { type: "bandpass", from: 3200, q: 1.2 },
      send: 0.25,
      ...(at ? { at } : {}),
    });
    synth.voice({
      freq: 1900,
      freqEnd: 900,
      type: "triangle",
      gain: 0.06 * g,
      decay: 0.12,
      send: 0.3,
      ...(at ? { at } : {}),
    });
    synth.voice({
      freq: 90,
      freqEnd: 55,
      gain: 0.1 * g,
      decay: 0.1,
      delay: 0.01,
      ...(at ? { at } : {}),
    });
  };

  const founded = (at: At, own: boolean): void => {
    const g = own ? 1 : 0.5;
    // Timber going up, then a small chime: a place now exists.
    synth.voice({ freq: 160, freqEnd: 120, type: "triangle", gain: 0.16 * g, decay: 0.09, at });
    synth.voice({
      noise: true,
      gain: 0.06 * g,
      decay: 0.06,
      filter: { type: "bandpass", from: 900, q: 1 },
      at,
    });
    synth.voice({ freq: 880, gain: 0.1 * g, decay: 0.45, delay: 0.12, send: 0.5, at });
  };

  const rose = (at: At, own: boolean, tier: number): void => {
    const g = own ? 1 : 0.5;
    // A bell for the tier, each one higher and longer than the last.
    const f = 440 * 2 ** ((Math.min(tier, 5) / 12) * 2);
    synth.voice({ freq: f, gain: 0.12 * g, decay: 0.7, send: 0.55, at });
    synth.voice({ freq: f * 2.76, gain: 0.04 * g, decay: 0.4, send: 0.55, at });
  };

  const fell = (at: At, own: boolean): void => {
    const g = own ? 1 : 0.6;
    // Masonry coming down: a low rumble of noise that darkens as it settles.
    synth.voice({
      noise: true,
      gain: 0.22 * g,
      attack: 0.02,
      decay: 0.7,
      filter: { type: "lowpass", from: 700, to: 180, q: 0.8 },
      send: 0.4,
      at,
    });
    synth.voice({ freq: 70, freqEnd: 40, gain: 0.14 * g, decay: 0.5, at });
  };

  return {
    reset(): void {
      // The cooldowns are tick stamps, and `known` is the old match's census: left
      // alone across a restart, no clash sounded until the new match's tick passed
      // the old one's, and the first sync mourned every settlement of the dead
      // world at once.
      lastCombat = -1;
      lastMerges = -1;
      lastClash = -1_000;
      lastMerge = -1_000;
      known.clear();
    },

    sync(sim, tick, localPlayer): void {
      // --- combat --------------------------------------------------------------
      const combat = sim.e.dio_census_combat() >>> 0;
      const merges = sim.e.dio_census_merges() >>> 0;
      if (lastCombat < 0) {
        lastCombat = combat;
        lastMerges = merges;
      }
      if (combat > lastCombat && tick - lastClash >= CLASH_COOLDOWN_TICKS) {
        lastClash = tick;
        const delta = combat - lastCombat;
        // Where: the first cell holding walkers of both gods.
        occupants.clear();
        let at: At | undefined;
        for (const w of sim.walkers()) {
          const key = sim.idx(w.face, Math.floor(w.x), Math.floor(w.y));
          const bits = (occupants.get(key) ?? 0) | (1 << w.owner);
          occupants.set(key, bits);
          if (bits === 3) {
            at = { face: w.face, x: Math.floor(w.x), y: Math.floor(w.y) };
            break;
          }
        }
        clash(at, Math.min(1, delta / 4));
      }
      if (merges > lastMerges && tick - lastMerge >= CLASH_COOLDOWN_TICKS) {
        lastMerge = tick;
        // Two bands joining: a soft, low thump, unplaced.
        synth.voice({ freq: 200, freqEnd: 140, gain: 0.05, decay: 0.12 });
      }
      lastCombat = combat;
      lastMerges = merges;

      // --- settlements ---------------------------------------------------------
      seen.clear();
      for (const s of sim.settlements()) {
        seen.add(s.slot);
        const at = { face: s.face, x: s.x, y: s.y };
        const own = s.owner === localPlayer;
        const k = known.get(s.slot);
        if (!k) {
          // The first sync of a match learns the seeded homes silently.
          if (known.size > 0 || tick > 1) founded(at, own);
          known.set(s.slot, { tier: s.tier, owner: s.owner, face: s.face, x: s.x, y: s.y });
          continue;
        }
        if (k.owner !== s.owner || k.face !== s.face || k.x !== s.x || k.y !== s.y) {
          // The slot was recycled between two ticks: one settlement fell and
          // another was founded into its number. Both happened.
          fell({ face: k.face, x: k.x, y: k.y }, k.owner === localPlayer);
          founded(at, own);
          known.set(s.slot, { tier: s.tier, owner: s.owner, face: s.face, x: s.x, y: s.y });
          continue;
        }
        if (s.tier > k.tier) rose(at, own, s.tier);
        k.tier = s.tier;
        k.owner = s.owner;
      }
      for (const [slot, k] of known) {
        if (seen.has(slot)) continue;
        fell({ face: k.face, x: k.x, y: k.y }, k.owner === localPlayer);
        known.delete(slot);
      }
    },
  };
}
