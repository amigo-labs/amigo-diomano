/**
 * Keyboard state, in one place. HANDOFF §8.
 *
 * # Why the verbs are keys and not a drag
 *
 * Raise/lower used to be a left-drag: vertical distance decided *how much* and
 * the pointer decided *where*, at the same time. At the default zoom a cell is
 * about 20 screen pixels and one terrace step was 14, so raising three terraces
 * smeared the stroke across two cells — you asked for a hill and got a ridge.
 * It also forced a 5 px / 400 ms click test to tell a sculpt from the magnet,
 * and that test is what once made nearly every stroke end by teleporting the
 * population.
 *
 * So the mouse only *points* now and the keys *act*: the hand stays where it is
 * pointed, `R` raises under it and `F` lowers. A held key repeats on the
 * simulation's own clock rather than on pixels of travel, which makes "one
 * terrace" a keystroke and "a hill" a hold — and the magnet gets the left button
 * to itself.
 *
 * # Why Alt and Ctrl are no longer modifiers
 *
 * §5.3's thrown / increased / extreme used to be shift / alt / ctrl, read off
 * whatever event was in hand. With verbs on letter keys that is untenable:
 * `Ctrl+R` is a reload and `Ctrl+F` is the browser's find bar, so an "extreme
 * raise" would reload the page. Shift survives as *thrown* — it modifies
 * nothing the browser wants — and the size modifiers move to `B`, which cycles
 * through them. The footprint ring already previews what they do, so a cycling
 * key needs no readout of its own.
 *
 * Every key here is ignored when Ctrl, Cmd or Alt is down (those chords belong
 * to the browser and the window manager), auto-repeat is dropped in favour of
 * the hand's own cadence (`HOLD_TICKS` in `hand.ts`, paced by the tick), and
 * `blur` releases everything: alt-tabbing away with `R` held must not leave the
 * hand digging in a tab nobody is looking at.
 */

import { MOD } from "./verbs";

/** `KeyboardEvent.code` values, so the bindings are physical and layout-proof. */
export const CODE = {
  raise: "KeyR",
  lower: "KeyF",
  brush: "KeyB",
  menu: "Space",
  orbitLeft: ["KeyA", "ArrowLeft"],
  orbitRight: ["KeyD", "ArrowRight"],
  orbitUp: ["KeyW", "ArrowUp"],
  orbitDown: ["KeyS", "ArrowDown"],
  // Arrays like the orbit pairs, because `axis` reads pairs of sets — `Q` and
  // `E` simply have one member each.
  zoomIn: ["KeyQ"],
  zoomOut: ["KeyE"],
} as const;

/** The brush sizes `B` cycles through, in order. */
const BRUSH_CYCLE = [0, MOD.INCREASED, MOD.EXTREME] as const;

/** Every code this module claims, so nothing else has to enumerate them. */
const CLAIMED = new Set<string>([
  CODE.raise,
  CODE.lower,
  CODE.brush,
  CODE.menu,
  ...CODE.orbitLeft,
  ...CODE.orbitRight,
  ...CODE.orbitUp,
  ...CODE.orbitDown,
  ...CODE.zoomIn,
  ...CODE.zoomOut,
]);

export interface Keys {
  /** Whether that physical key is down right now. */
  held(code: string): boolean;
  /** Whether any of them is. */
  heldAny(codes: readonly string[]): boolean;
  /**
   * `-1`, `0` or `1` for a pair of opposed keys, so a caller reads an axis
   * rather than two booleans. Both down cancels, which is what a player
   * rolling their fingers across `A` and `D` means.
   */
  axis(negative: readonly string[], positive: readonly string[]): number;
  /**
   * Register a callback for the *press* of one key — not its repeats. Returns
   * nothing; the listeners live as long as the page.
   */
  onPress(code: string, fn: () => void): void;
  /** §5.3's modifier bits: shift is thrown, `B` supplies the size. */
  modifier(): number;
  /** Which of `BRUSH_CYCLE` is selected, for the radial menu's mod line. */
  brush(): number;
  /** Forget every held key. A restart, and any loss of focus. */
  release(): void;
  /** Which keys are down, for the `window.diomano` console handle. */
  inspect(): string[];
}

export function createKeys(): Keys {
  const down = new Set<string>();
  const pressHandlers = new Map<string, (() => void)[]>();
  let brushIndex = 0;
  let shift = false;

  addEventListener("keydown", (ev) => {
    // macOS delivers no `keyup` for a key released while Command is down, so a
    // sculpt key held into a Command chord would read as held until it was
    // pressed again. Command takes the keyboard for the chord; let go of
    // everything, as a blur does.
    if (ev.key === "Meta") forget();
    // Those chords are the browser's and the window manager's. Reading them as
    // game input is how `Ctrl+R` becomes "extreme raise" and reloads the page.
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    shift = ev.shiftKey;
    if (!CLAIMED.has(ev.code)) return;
    // Space scrolls, and the arrows scroll: claimed keys must not also drive
    // the page under the canvas.
    ev.preventDefault();
    // Auto-repeat fires at the OS's typing rate, which has nothing to do with
    // the tick. `beforeTick` paces the held case itself.
    if (ev.repeat) return;
    down.add(ev.code);
    if (ev.code === CODE.brush) brushIndex = (brushIndex + 1) % BRUSH_CYCLE.length;
    for (const fn of pressHandlers.get(ev.code) ?? []) fn();
  });

  addEventListener("keyup", (ev) => {
    shift = ev.shiftKey;
    down.delete(ev.code);
  });

  // Anything that takes the keyboard away releases the keys it was holding: a
  // key-up that lands on another window never reaches this page, so without
  // this a hand holding `R` at the moment of alt-tab digs until the player
  // comes back and presses it again.
  const forget = (): void => {
    down.clear();
    shift = false;
  };
  addEventListener("blur", forget);
  // And the tab going hidden, which a browser can do without a `blur`: the
  // `keyup` for a key held at that moment lands on whatever took the screen,
  // and the key would read as down until it was pressed again.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) forget();
  });

  return {
    held: (code) => down.has(code),
    heldAny: (codes) => codes.some((code) => down.has(code)),
    axis(negative, positive): number {
      const a = negative.some((code) => down.has(code)) ? 1 : 0;
      const b = positive.some((code) => down.has(code)) ? 1 : 0;
      return b - a;
    },
    onPress(code, fn): void {
      const list = pressHandlers.get(code);
      if (list) list.push(fn);
      else pressHandlers.set(code, [fn]);
    },
    modifier: () => (shift ? MOD.THROWN : 0) | (BRUSH_CYCLE[brushIndex] ?? 0),
    brush: () => BRUSH_CYCLE[brushIndex] ?? 0,
    release(): void {
      down.clear();
      shift = false;
    },
    /** Which keys are down. For the console handle in `game.ts` only. */
    inspect: () => [...down],
  };
}
