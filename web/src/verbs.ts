/**
 * Verb, modifier and power constants — mirrors of `crates/diomano-sim/src/world.rs`.
 *
 * A module of its own so that every input surface (the hand, the radial power
 * menu, audio, effects) can import them without importing `main.ts`: the old
 * arrangement had the gesture recogniser importing `VERB` from the module that
 * imported *it*, and the resulting cycle needed a lazily-built template table
 * to dodge the TDZ. Constants at the bottom of the graph end that.
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
