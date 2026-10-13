/**
 * The two gods' colours, in one place.
 *
 * Player 0 is warm — gold, sand, late afternoon — and player 1 is cool — sky,
 * slate, morning. Every surface that says "this is whose" draws from here: the
 * walkers, the settlements, the papal magnets, and the influence tint the
 * terrain and the sea blend between. They used to be literals in three files,
 * so a change to one side's hue meant finding every copy of it by eye.
 *
 * The values are linear RGB triples, not hex: most of them are fed to
 * `Color.setRGB` or straight into a uniform, and several go *above* 1 — a
 * multiplier on the terrain's albedo rather than a colour in its own right.
 *
 * This module imports nothing at runtime, so any renderer file and the model
 * gallery can read it without pulling in anything else.
 */

/** A linear RGB triple. */
export type Rgb = readonly [number, number, number];

/** One entry per player, indexed by the owner id the simulation reports. */
export type PerPlayer = readonly [Rgb, Rgb];

/** The per-instance tint of a walker's figure. */
export const WALKER_TEAM: PerPlayer = [
  [1.0, 0.85, 0.5],
  [0.5, 0.85, 1.0],
];

/**
 * Rank on top of side: the colour a champion is drawn in, and the one a
 * leader's tint is pulled toward. Not per player — rank reads the same on both
 * sides.
 */
export const CHAMPION_ACCENT: Rgb = [1.0, 0.42, 0.24];
export const LEADER_ACCENT: Rgb = [1.0, 0.95, 0.7];

/** The per-instance tint of a settlement's buildings. */
export const SETTLEMENT_TEAM: PerPlayer = [
  [0.95, 0.82, 0.6],
  [0.62, 0.82, 0.98],
];

/** The papal magnet's tint. */
export const MAGNET_TEAM: PerPlayer = [
  [1.0, 0.9, 0.55],
  [0.55, 0.9, 1.0],
];

/**
 * The terrain's influence mood (`planet.ts`, `uGodA` / `uGodB`): multiplied
 * into the ground's albedo by how strongly each god holds it. Above 1 on the
 * owner's own channel, so a held valley warms rather than only darkening.
 */
export const TERRAIN_GOD: PerPlayer = [
  [1.06, 0.93, 0.82],
  [0.82, 0.9, 1.1],
];

/**
 * The sea's influence mood (`water.ts`): the terrain's, a little weaker — it
 * tints a surface that is already a strong colour of its own.
 */
export const WATER_GOD: PerPlayer = [
  [1.05, 0.95, 0.85],
  [0.85, 0.92, 1.1],
];

/** The colour for `owner`, clamped so an unexpected id draws as player 1, not as black. */
export function teamColour(table: PerPlayer, owner: number): Rgb {
  return table[owner === 0 ? 0 : 1];
}
