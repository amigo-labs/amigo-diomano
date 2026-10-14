/**
 * What the *population* did this tick: fighting, founding, rising, falling.
 *
 * The client sees its own commands and the applied-verb ring, and nothing
 * else about what happened in a tick. So this reads the state that is already
 * exported — the diagnostic census counters, the walker and settlement views —
 * and diffs it tick to tick. Combat is the count of resolutions going up;
 * where it happened is found by looking for the cell where walkers of both
 * gods stand. A settlement is founded when a slot appears, rises when its tier
 * does, falls when its slot goes dark.
 *
 * # One diff, three readers
 *
 * This used to live inside `audio/events.ts`, private to the sound. The
 * particles (`renderer/effects.ts`), the off-screen pips
 * (`renderer/indicators.ts`) and the readouts (`hud.ts`) want the same answers,
 * and three copies of a diff over slot recycling would disagree with each other
 * the first time one of them was fixed. So it is computed once per frame in
 * `game.ts` and the list is handed to every consumer.
 *
 * It imports nothing at runtime — `Sim` is a type — so anything can read it
 * without a cycle (`tools/verify-cycles.mjs`).
 *
 * None of it feeds back. The census is write-only from the simulation's point
 * of view and stays so; this only reads it (§10).
 */

import type { Sim } from "./main";

/** Fewest ticks between two clash events. Six a second is a battle; thirty is a buzz. */
const CLASH_COOLDOWN_TICKS = 5;

/** A settlement appeared, gained a tier, or went dark. */
export interface SettlementEvent {
  kind: "founded" | "rose" | "fell";
  owner: number;
  face: number;
  x: number;
  y: number;
  /** The tier it has now — or, for `fell`, the tier it had. */
  tier: number;
}

/**
 * Combat resolutions went up since the last tick looked.
 *
 * `located` is false when no cell held walkers of both gods at the moment of
 * looking — the fight was resolved and one side already gone — and then
 * `face`, `x` and `y` are zero and mean nothing. The sound plays unplaced; the
 * picture has nowhere to draw and skips it.
 */
export interface ClashEvent {
  kind: "clash";
  located: boolean;
  face: number;
  x: number;
  y: number;
  /** 0..1, by how many resolutions this tick added. */
  strength: number;
}

/** Two bands of the same god joined. Unplaced: the census does not say where. */
export interface MergeEvent {
  kind: "merge";
}

export type WorldEvent = SettlementEvent | ClashEvent | MergeEvent;

export interface WorldEvents {
  /**
   * Once per frame. Diffs only when the tick moved since the last call and
   * returns the same empty list otherwise, so every reader can be handed the
   * result unconditionally.
   */
  sync(sim: Sim): readonly WorldEvent[];
  /** Forget the match, for a restart: the next sync learns the new world silently. */
  reset(): void;
}

interface Known {
  tier: number;
  owner: number;
  face: number;
  x: number;
  y: number;
}

export function createWorldEvents(): WorldEvents {
  let lastTick = -1;
  let lastCombat = -1;
  let lastMerges = -1;
  let lastClash = -1_000;
  let lastMerge = -1_000;
  /**
   * Whether the seeded homes have been learned. The first sync of a match
   * records them without announcing them; this used to be decided as
   * "`known` is empty and the tick is at most 1", which a frame that caught up
   * two ticks at once after a restart got wrong — every home of the new world
   * was then "founded" in one breath.
   */
  let primed = false;
  const known = new Map<number, Known>();
  const seen = new Set<number>();
  /** Cell → bitmask of owners with a walker on it, rebuilt when combat rose. */
  const occupants = new Map<number, number>();
  const none: readonly WorldEvent[] = [];

  return {
    reset(): void {
      // The cooldowns are tick stamps and `known` is the old match's census:
      // left alone across a restart, no clash fired until the new match's tick
      // passed the old one's, and the first sync mourned every settlement of the
      // dead world at once.
      lastTick = -1;
      lastCombat = -1;
      lastMerges = -1;
      lastClash = -1_000;
      lastMerge = -1_000;
      primed = false;
      known.clear();
    },

    sync(sim: Sim): readonly WorldEvent[] {
      const tick = sim.e.dio_tick_count();
      if (tick === lastTick) return none;
      lastTick = tick;
      const out: WorldEvent[] = [];

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
        const clash: ClashEvent = {
          kind: "clash",
          located: false,
          face: 0,
          x: 0,
          y: 0,
          strength: Math.min(1, delta / 4),
        };
        for (const w of sim.walkers()) {
          const x = Math.floor(w.x);
          const y = Math.floor(w.y);
          const key = sim.idx(w.face, x, y);
          const bits = (occupants.get(key) ?? 0) | (1 << w.owner);
          occupants.set(key, bits);
          if (bits === 3) {
            clash.located = true;
            clash.face = w.face;
            clash.x = x;
            clash.y = y;
            break;
          }
        }
        out.push(clash);
      }
      if (merges > lastMerges && tick - lastMerge >= CLASH_COOLDOWN_TICKS) {
        lastMerge = tick;
        out.push({ kind: "merge" });
      }
      lastCombat = combat;
      lastMerges = merges;

      // --- settlements ---------------------------------------------------------
      seen.clear();
      // Decided once, before the loop: evaluated per settlement, the first
      // seeded home filled `known` and every further one in the same sync
      // announced itself.
      const learning = !primed;
      primed = true;
      for (const s of sim.settlements()) {
        seen.add(s.slot);
        const k = known.get(s.slot);
        if (!k) {
          if (!learning) out.push(settlementEvent("founded", s));
          known.set(s.slot, { tier: s.tier, owner: s.owner, face: s.face, x: s.x, y: s.y });
          continue;
        }
        if (k.owner !== s.owner || k.face !== s.face || k.x !== s.x || k.y !== s.y) {
          // The slot was recycled between two ticks: one settlement fell and
          // another was founded into its number. Both happened.
          out.push(settlementEvent("fell", k));
          out.push(settlementEvent("founded", s));
          known.set(s.slot, { tier: s.tier, owner: s.owner, face: s.face, x: s.x, y: s.y });
          continue;
        }
        if (s.tier > k.tier) out.push(settlementEvent("rose", s));
        k.tier = s.tier;
        k.owner = s.owner;
      }
      for (const [slot, k] of known) {
        if (seen.has(slot)) continue;
        out.push(settlementEvent("fell", k));
        known.delete(slot);
      }
      return out.length > 0 ? out : none;
    },
  };
}

function settlementEvent(kind: SettlementEvent["kind"], s: Known): SettlementEvent {
  return { kind, owner: s.owner, face: s.face, x: s.x, y: s.y, tier: s.tier };
}
