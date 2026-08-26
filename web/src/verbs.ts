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

/** §5.3's modifiers, read live so releasing shift mid-drag takes effect. */
export function readModifier(ev: PointerEvent | MouseEvent): number {
  return (
    (ev.shiftKey ? MOD.THROWN : 0) |
    (ev.altKey ? MOD.INCREASED : 0) |
    (ev.ctrlKey ? MOD.EXTREME : 0)
  );
}

/**
 * Every binding the player has, in the order they are worth learning.
 *
 * One table, two readers: the title card lists it before the match (`ui.ts`)
 * and the F1 overlay lists it during (`hud.ts`). Adding a key means adding it
 * here, and it appears in both. Player-facing strings are German (Phase 9);
 * code and comments stay English.
 */
export const CONTROLS: readonly (readonly [string, string])[] = [
  ["Ziehen (links)", "Land heben / senken — die Hand füllt und leert sich"],
  ["Klick (links)", "Magnet setzen: dein Volk folgt ihm"],
  ["Ziehen (rechts)", "Planet drehen · Mausrad: Zoom"],
  ["Klick (rechts)", "Kraftmenü öffnen — Kräfte kosten Mana"],
  ["1 / 2 / 3", "Erde / Wasser / Lava greifen"],
  ["Umschalt / Alt / Strg", "geworfen / verstärkt / extrem"],
  ["Esc", "Kraftmenü schließen"],
  ["+ / = / − / M", "lauter / leiser / stumm"],
  ["F1 oder ?", "diese Steuerung ein- und ausblenden"],
] as const;
