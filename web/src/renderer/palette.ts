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
 * It also holds the GLSL that applies the side's colour (`TEAM_MASK_GLSL`),
 * because *where* a side's colour goes is as much a palette decision as which
 * colour it is.
 *
 * This module imports only the power ids, which import nothing, so any renderer
 * file and the model gallery can read it without pulling in anything else.
 */

import { POWER } from "../verbs";

/** A linear RGB triple. */
export type Rgb = readonly [number, number, number];

/** One entry per player, indexed by the owner id the simulation reports. */
export type PerPlayer = readonly [Rgb, Rgb];

/**
 * The heraldic pair: amber and sky. Saturated, because since the team mask they
 * colour only the parts that are *meant* to be the side's — a banner, a
 * tabard, a roof cap — rather than washing a whole building pastel. A banner a
 * dozen pixels tall has to carry its side on hue alone.
 */
const HERALDRY: PerPlayer = [
  [1.0, 0.55, 0.08],
  [0.1, 0.38, 1.0],
];

/** The per-instance tint of a walker: the tabard, under the team mask. */
export const WALKER_TEAM: PerPlayer = HERALDRY;

/**
 * Rank on top of side: the champion's ember glow and rim, and the warm rim a
 * leader carries. Not per player — rank reads the same on both sides, and it
 * is drawn *over* the side's colour rather than instead of it.
 */
export const CHAMPION_ACCENT: Rgb = [1.0, 0.42, 0.24];
export const LEADER_ACCENT: Rgb = [1.0, 0.95, 0.7];

/** The per-instance tint of a settlement: its pennants, banners, flags and team roofs. */
export const SETTLEMENT_TEAM: PerPlayer = HERALDRY;

/** The papal magnet's tint: its banners and finial, and a little of its obelisk. */
export const MAGNET_TEAM: PerPlayer = HERALDRY;

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

/**
 * A pickup crystal's colour, by the power it grants (sRGB hex, as `Color`
 * takes it). The crystal used to be one gold for every power, so a player had
 * to fly the hand over it to learn whether it was worth a detour. Each hue
 * borrows from what the power does on the ground — lava red, flood blue, the
 * swamp's bile green — and the champion keeps the old gold.
 */
export const PICKUP_POWER: Readonly<Record<number, number>> = {
  [POWER.RAISE_LOWER]: 0xd9b57a,
  [POWER.MAGNET]: 0xf2f0ff,
  [POWER.EARTHQUAKE]: 0xe08a3c,
  [POWER.SWAMP]: 0x7ed957,
  [POWER.VOLCANO]: 0xff5530,
  [POWER.FLOOD]: 0x4cc3ff,
  [POWER.CHAMPION]: 0xffe066,
  [POWER.ARMAGEDDON]: 0xc77dff,
};

/** A power id the table does not know draws in the champion's gold, never black. */
export function pickupColour(power: number): number {
  return PICKUP_POWER[power] ?? 0xffe066;
}

/**
 * How much of the side's colour a part with no team mask still takes: a
 * breath of it, so a wall or a face is warm or cool by owner even where it is
 * too small to show a banner, without going pastel the way the whole-building
 * tint did.
 */
export const TEAM_WASH = 0.15;

/**
 * The team mask, as GLSL for a `MeshLambertMaterial`'s vertex shader.
 *
 * `head` declares the attribute; `colour` *replaces* three's `color_vertex`
 * chunk. Stock three multiplies `instanceColor` into every vertex, which is why
 * the owner's tint used to be on the door, the thatch and the villager's face
 * alike. Here it goes in by the per-vertex `team` weight (`teamPart` in
 * `models.ts`, `_TEAM` in the figure's GLB): fully where the mask is 1, at
 * `TEAM_WASH` where it is 0.
 *
 * The geometry must carry `team`. A Lambert material, unlike a
 * `ShaderMaterial`, has no default attribute values, so a missing one reads
 * whatever generic value that attribute location last held — which is why
 * `vegetation.ts` fills it on every geometry it hands these materials.
 */
export const TEAM_MASK_GLSL = {
  head: /* glsl */ "attribute float team;",
  colour: /* glsl */ `
    #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
      vColor = vec3( 1.0 );
    #endif
    #ifdef USE_COLOR
      vColor *= color;
    #endif
    #ifdef USE_INSTANCING_COLOR
      vColor *= mix( vec3( 1.0 ), instanceColor, max( team, ${TEAM_WASH.toFixed(3)} ) );
    #endif`,
} as const;
