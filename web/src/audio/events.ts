/**
 * Sounds for what the *population* does: fighting, founding, rising, falling.
 *
 * The diff that finds those moments lives in `worldEvents.ts`, shared with the
 * particles, the off-screen pips and the readouts; this only gives each one a
 * voice — placed where it happened, quieter when it is the other god's.
 */

import type { WorldEvent } from "../worldEvents";
import type { At, Synth } from "./synth";

export interface Events {
  /** Voice what the world did since the last call (`WorldEvents.sync`). */
  play(events: readonly WorldEvent[], localPlayer: number): void;
}

export function createEvents(synth: Synth): Events {
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
    play(events, localPlayer): void {
      for (const ev of events) {
        switch (ev.kind) {
          case "clash":
            clash(ev.located ? { face: ev.face, x: ev.x, y: ev.y } : undefined, ev.strength);
            break;
          case "merge":
            // Two bands joining: a soft, low thump, unplaced.
            synth.voice({ freq: 200, freqEnd: 140, gain: 0.05, decay: 0.12 });
            break;
          case "founded":
            founded({ face: ev.face, x: ev.x, y: ev.y }, ev.owner === localPlayer);
            break;
          case "rose":
            rose({ face: ev.face, x: ev.x, y: ev.y }, ev.owner === localPlayer, ev.tier);
            break;
          case "fell":
            fell({ face: ev.face, x: ev.x, y: ev.y }, ev.owner === localPlayer);
            break;
        }
      }
    },
  };
}
