/**
 * Verb, modifier and power constants — mirrors of `crates/diomano-sim/src/world.rs`.
 *
 * A module of its own so that every input surface (the hand, the radial power
 * menu, audio, effects) can import them without importing `main.ts`, which used
 * to sit at the top of the graph and import them back. Constants at the bottom
 * of the graph end that.
 *
 * `CONTROLS` lives here for the same reason: the title card (`ui.ts`) and the
 * in-match overlay (`hud.ts`) must not each keep their own copy of the key
 * table. They already drifted once — the card listed `+ / − / M` while the
 * handler also accepted `=`, and the docs listed neither.
 *
 * The live keyboard *state* is not here: `keys.ts` owns which keys are down and
 * therefore what §5.3's modifier bits currently are. This module is constants
 * and one table, and imports nothing.
 *
 * They are not exported from wasm one getter each because that would be forty
 * exports to avoid one comment; `assertLayout` in `main.ts` checks the things
 * that actually change silently (grid size, struct strides) at load time. The
 * two that a *map manifest* can change per map — power costs and enablement —
 * are exported (`dio_power_cost`, `dio_power_enabled`) and read live.
 */

export const VERB = {
  NOP: 0,
  RAISE: 1,
  LOWER: 2,
  MAGNET: 3,
  EARTHQUAKE: 4,
  SWAMP: 5,
  VOLCANO: 6,
  FLOOD: 7,
  CHAMPION: 8,
  ARMAGEDDON: 9,
  SET_HAND: 10,
} as const;

export const MOD = {
  THROWN: 1 << 0,
  INCREASED: 1 << 1,
  EXTREME: 1 << 2,
} as const;

export const HAND_MATERIAL = { EARTH: 0, WATER: 1, LAVA: 2 } as const;

/** Power indices of `world.rs` — the manifest's cost/enablement arrays. */
export const POWER = {
  RAISE_LOWER: 0,
  MAGNET: 1,
  EARTHQUAKE: 2,
  SWAMP: 3,
  VOLCANO: 4,
  FLOOD: 5,
  CHAMPION: 6,
  ARMAGEDDON: 7,
} as const;

/**
 * Every binding the player has, in the order they are worth learning.
 *
 * One table, two readers: the title card lists it before the match (`ui.ts`)
 * and the F1 overlay lists it during (`hud.ts`). Adding a key means adding it
 * here, and it appears in both. Player-facing strings are German (Phase 9);
 * code and comments stay English.
 */
export const CONTROLS: readonly (readonly [string, string])[] = [
  ["R / F", "Land heben / senken — halten formt weiter"],
  ["Klick (links)", "Magnet setzen: dein Volk folgt ihm"],
  ["Rechtsklick / Leertaste", "Kraftmenü öffnen — Kräfte kosten Mana"],
  ["W A S D / Pfeile", "Planet drehen"],
  ["Q / E · Mausrad", "näher / weiter"],
  [
    "F über Wasser / Lava",
    "schöpft Wasser / Lava statt Erde — die leere Hand nimmt, was unter ihr liegt",
  ],
  ["Umschalt", "geworfen: größerer Umkreis am Einschlagpunkt"],
  ["B", "Pinselgröße: normal → verstärkt → extrem"],
  ["Esc", "Kraftmenü schließen"],
  ["+ / = / − / M", "lauter / leiser / stumm"],
  ["F1 oder ?", "diese Steuerung ein- und ausblenden"],
] as const;
