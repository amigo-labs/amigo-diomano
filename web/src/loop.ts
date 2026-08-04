/**
 * Fixed-timestep game loop. HANDOFF §4.1.
 *
 * Fixed 30 Hz simulation tick. No variable timestep, ever. The render
 * interpolates between the last two simulation states; it never advances state.
 *
 * The accumulator is the whole design: `update` is called a whole number of
 * times per frame and `render` is handed the leftover fraction. A frame that
 * takes 100 ms runs three ticks, not one long one — game feel and every tuning
 * value in the spec depend on a tick always meaning the same amount of world
 * time.
 */

/** Simulation rate. Fixed, forever (§4.1). */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/**
 * Most ticks to run in one frame before giving up and dropping the rest.
 *
 * Without a cap, a tab that was backgrounded for a minute returns owing 1800
 * ticks, spends ten seconds catching up, and falls further behind while it does
 * — the classic spiral of death. Dropping simulation time is wrong in a
 * lockstep match and will be replaced by a stall in the netcode phase; until
 * then, dropping is the honest local behaviour.
 */
const MAX_CATCHUP_TICKS = 5;

export interface LoopHooks {
  /** Advance the simulation exactly one tick. */
  update(tick: number): void;
  /**
   * Draw. `alpha` is the fraction of a tick elapsed since the last `update`,
   * in `[0, 1)`, for interpolating render state.
   */
  render(alpha: number, dtMs: number): void;
  /** Called once per second with the measured frame and tick rates. */
  stats?(fps: number, tps: number, droppedTicks: number): void;
}

export interface Loop {
  start(): void;
  stop(): void;
  /** Ticks executed since `start`. */
  readonly tick: number;
}

export function createLoop(hooks: LoopHooks): Loop {
  let running = false;
  let raf = 0;
  let last = 0;
  let accumulator = 0;
  let tick = 0;
  let dropped = 0;

  let frames = 0;
  let ticksThisSecond = 0;
  let statsAt = 0;

  const frame = (now: number): void => {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    const dt = Math.min(now - last, 1000);
    last = now;
    accumulator += dt;

    let ran = 0;
    while (accumulator >= TICK_MS && ran < MAX_CATCHUP_TICKS) {
      hooks.update(tick);
      tick += 1;
      ran += 1;
      ticksThisSecond += 1;
      accumulator -= TICK_MS;
    }
    if (accumulator >= TICK_MS) {
      // Still behind after the cap: discard the debt rather than compound it.
      dropped += Math.floor(accumulator / TICK_MS);
      accumulator = accumulator % TICK_MS;
    }

    hooks.render(accumulator / TICK_MS, dt);

    frames += 1;
    if (now - statsAt >= 1000) {
      hooks.stats?.(
        (frames * 1000) / (now - statsAt),
        (ticksThisSecond * 1000) / (now - statsAt),
        dropped,
      );
      frames = 0;
      ticksThisSecond = 0;
      statsAt = now;
    }
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      last = performance.now();
      statsAt = last;
      accumulator = 0;
      raf = requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      cancelAnimationFrame(raf);
    },
    get tick(): number {
      return tick;
    },
  };
}
