/**
 * Gesture recognition. HANDOFF §8, §6.2.
 *
 * # Sampled on a fixed timer, never per frame
 *
 * §6.2 is explicit and gives the reason: Black & White 2 failed to recognise
 * gestures at low frame rates, and that failure mode is avoidable. So the
 * pointer path is sampled by a `setInterval` at a fixed rate and the recogniser
 * never sees `requestAnimationFrame`. At 15 fps the sampled path is identical to
 * the one at 60 fps, which is the Phase 6 DoD stated as a mechanism rather than
 * as a hope.
 *
 * Recognition runs entirely client-side; only the result `(verb, modifier)`
 * enters the command stream (§6.2).
 *
 * # How it recognises
 *
 * The path is resampled to a fixed number of points, each segment is quantised
 * to one of eight headings, and runs are collapsed — so a stroke becomes a short
 * string like "E S W N". Templates are matched against that string. This is
 * scale- and speed-invariant and small enough to read, which matters more than
 * accuracy at the margins: a mis-recognised Armageddon is unrecoverable, so
 * Armageddon is the one gesture gated behind a hold instead.
 */

import { MOD, VERB } from "./main";

/** Sampling rate. Independent of frame rate, by construction. */
const SAMPLE_HZ = 60;
const SAMPLE_MS = 1000 / SAMPLE_HZ;
/** Minimum pixels between retained samples, so a still pointer adds nothing. */
const MIN_SAMPLE_DISTANCE = 6;
/** Points a stroke is resampled to before quantising. */
const RESAMPLE_POINTS = 32;
/** Total turning, in radians, that counts as a spiral. */
const SPIRAL_TURN = Math.PI * 1.8;
/** Milliseconds of hold that confirms Armageddon. */
const ARMAGEDDON_HOLD_MS = 2000;

type Emit = (verb: number, modifier: number) => void;

export interface Gestures {
  start(): void;
  stop(): void;
  /** True once a spiral has armed gesture mode; the caller draws the trail. */
  readonly armed: boolean;
  /**
   * The stroke being drawn, in client pixels. Empty when nothing is tracked.
   *
   * §8 requires the armed state to be "confirmed by a light trail", and this is
   * what the trail is drawn from. Before it existed, `armed` was exported and
   * read by nobody: arming a gesture produced no feedback of any kind, so there
   * was no way to tell gesture mode from a camera drag.
   */
  readonly stroke: readonly { readonly x: number; readonly y: number }[];
}

interface Point {
  x: number;
  y: number;
  t: number;
}

interface Template {
  name: string;
  verb: number;
  pattern: string[];
}

let templateCache: Template[] | null = null;

/**
 * The gesture set of §8, as heading templates.
 *
 * Headings are compass letters over an eight-way quantisation, runs collapsed.
 * Templates are matched as subsequences, so an untidy stroke with a wobble in
 * the middle still reads.
 *
 * Built on first use rather than at module scope, and that is not a
 * micro-optimisation: `main.ts` imports this module and this module imports
 * `VERB` back from it, so reading `VERB` while the module graph is still
 * evaluating hits the temporal dead zone and the page dies with "cannot access
 * before initialization". Deferring the read to the first gesture sidesteps the
 * cycle without splitting the constants into a file the layout does not have.
 */
function templates(): Template[] {
  if (templateCache) return templateCache;
  templateCache = [
    // `~` — two horizontal reversals.
    { name: "flood", verb: VERB.FLOOD, pattern: ["E", "W", "E"] },
    { name: "flood-mirror", verb: VERB.FLOOD, pattern: ["W", "E", "W"] },
    // `∧` — up then down.
    { name: "volcano", verb: VERB.VOLCANO, pattern: ["NE", "SE"] },
    { name: "volcano-steep", verb: VERB.VOLCANO, pattern: ["N", "S"] },
    // `∪` — down then up.
    { name: "swamp", verb: VERB.SWAMP, pattern: ["SE", "NE"] },
    { name: "swamp-steep", verb: VERB.SWAMP, pattern: ["S", "N"] },
    // `Z` — across, back down-left, across.
    { name: "earthquake", verb: VERB.EARTHQUAKE, pattern: ["E", "SW", "E"] },
    // `+` — a cross, drawn as one stroke: across, back, down.
    { name: "champion", verb: VERB.CHAMPION, pattern: ["E", "W", "S"] },
    { name: "champion-alt", verb: VERB.CHAMPION, pattern: ["S", "N", "E"] },
  ];
  return templateCache;
}

/**
 * @param armedFlag Written whenever gesture mode arms or disarms, so the camera
 *   can stand down. `verbs.md` specifies right-drag as "orbit the planet" only
 *   when there is *no spiral* — both were bound to the same button with nothing
 *   implementing the qualifier, so every gesture spun the planet underneath
 *   itself while the recogniser was matching a screen-space path against it.
 */
export function createGestures(
  canvas: HTMLCanvasElement,
  emit: Emit,
  armedFlag: { value: boolean },
): Gestures {
  let timer = 0;
  let tracking = false;
  let armed = false;
  let armedAt = 0;
  let spiralsThisStroke = 0;
  let path: Point[] = [];
  let live: Point | null = null;
  let modifier = 0;

  const setArmed = (value: boolean): void => {
    armed = value;
    armedFlag.value = value;
  };

  const reset = (): void => {
    path = [];
    setArmed(false);
    spiralsThisStroke = 0;
    modifier = 0;
  };

  const sample = (): void => {
    if (!tracking || !live) return;
    const last = path[path.length - 1];
    if (last) {
      const dx = live.x - last.x;
      const dy = live.y - last.y;
      if (dx * dx + dy * dy < MIN_SAMPLE_DISTANCE * MIN_SAMPLE_DISTANCE) {
        // Held still. If gesture mode is armed and the pointer has been parked
        // long enough, that is the Armageddon confirmation (§8): the most
        // friction of any verb, because it is irreversible.
        if (armed && spiralsThisStroke >= 2 && performance.now() - armedAt > ARMAGEDDON_HOLD_MS) {
          emit(VERB.ARMAGEDDON, 0);
          tracking = false;
          reset();
        }
        return;
      }
    }
    path.push({ ...live });

    // Arming: a clockwise spiral turns gesture mode on. A second spiral while
    // still held escalates to the increased/extreme variant (§5.3).
    const turn = totalTurning(path);
    const spirals = Math.floor(Math.abs(turn) / SPIRAL_TURN);
    if (spirals > spiralsThisStroke) {
      spiralsThisStroke = spirals;
      if (!armed) {
        setArmed(true);
        armedAt = performance.now();
        // The stroke that armed the gesture is not part of the gesture.
        path = [{ ...live }];
      } else {
        modifier |= modifier & MOD.INCREASED ? MOD.EXTREME : MOD.INCREASED;
      }
    }
  };

  const onDown = (ev: PointerEvent): void => {
    // Gesture mode is the right button. The left button is the hand, and §8
    // requires raise/lower to stay gesture-free.
    if (ev.button !== 2) return;
    tracking = true;
    reset();
    live = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    path.push({ ...live });
  };

  const onMove = (ev: PointerEvent): void => {
    if (!tracking) return;
    live = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  };

  const onUp = (): void => {
    if (!tracking) return;
    tracking = false;
    if (armed) {
      const verb = classify(path);
      if (verb !== null) emit(verb, modifier);
    }
    reset();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  return {
    start(): void {
      if (timer !== 0) return;
      timer = setInterval(sample, SAMPLE_MS) as unknown as number;
    },
    stop(): void {
      clearInterval(timer);
      timer = 0;
    },
    get armed(): boolean {
      return armed;
    },
    get stroke(): readonly { readonly x: number; readonly y: number }[] {
      return path;
    },
  };
}

/** Signed total turning of a path, in radians. */
function totalTurning(points: readonly Point[]): number {
  let total = 0;
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2];
    const b = points[i - 1];
    const c = points[i];
    if (!a || !b || !c) continue;
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    const a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = a2 - a1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    total += d;
  }
  return total;
}

/** Resample to a fixed count, so speed and length stop mattering. */
function resample(points: readonly Point[], count: number): Point[] {
  if (points.length < 2) return [...points];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (length === 0) return [...points];

  const interval = length / (count - 1);
  const out: Point[] = [points[0]!];
  let travelled = 0;
  let i = 1;
  let prev = points[0]!;
  while (i < points.length && out.length < count) {
    const next = points[i]!;
    const d = Math.hypot(next.x - prev.x, next.y - prev.y);
    if (travelled + d >= interval) {
      const t = (interval - travelled) / d;
      const p: Point = {
        x: prev.x + (next.x - prev.x) * t,
        y: prev.y + (next.y - prev.y) * t,
        t: prev.t,
      };
      out.push(p);
      prev = p;
      travelled = 0;
    } else {
      travelled += d;
      prev = next;
      i += 1;
    }
  }
  while (out.length < count) out.push(points[points.length - 1]!);
  return out;
}

const HEADINGS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"] as const;

/** Quantise a stroke to a collapsed run of eight-way headings. */
export function headings(points: readonly Point[]): string[] {
  const pts = resample(points, RESAMPLE_POINTS);
  const out: string[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    // Screen y grows downward, so negate it to get compass directions.
    const angle = Math.atan2(-(b.y - a.y), b.x - a.x);
    const octant = ((Math.round((angle / (Math.PI * 2)) * 8) % 8) + 8) % 8;
    const h = HEADINGS[octant]!;
    if (out[out.length - 1] !== h) out.push(h);
  }
  return out;
}

/** Is `pattern` a subsequence of `seq`? */
function matches(seq: readonly string[], pattern: readonly string[]): boolean {
  let p = 0;
  for (const s of seq) {
    if (s === pattern[p]) p += 1;
    if (p === pattern.length) return true;
  }
  return false;
}

/**
 * Classify a stroke. Returns `null` when nothing matches — which is the right
 * answer far more often than a wrong verb would be, given every gesture here
 * costs mana and two of them are irreversible.
 */
export function classify(points: readonly Point[]): number | null {
  if (points.length < 4) return null;
  const seq = headings(points);
  for (const template of templates()) {
    if (matches(seq, template.pattern)) return template.verb;
  }
  return null;
}

/** Exposed so a test or a tool can build a synthetic stroke. */
export type GesturePoint = Point;
