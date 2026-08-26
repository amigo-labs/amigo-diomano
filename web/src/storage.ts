/**
 * Remembered settings, and the try/catch every one of them needs.
 *
 * `localStorage` *throws* rather than returning null when storage is disabled —
 * Safari's private mode, and any browser with site data blocked — and a game
 * that fails to start because it could not read a volume level would be an
 * absurd way to lose a player. So every read falls back and every write is
 * allowed to do nothing.
 *
 * Lives in its own module because three unrelated things now remember something:
 * the volume and the mute flag (`audio.ts`), and whether the controls overlay is
 * up (`hud.ts`). The title card also reads the volume *before* `audio.ts` is
 * loaded at all — see `main.ts` — so the helper cannot live inside the audio
 * graph any more.
 */

export function remembered<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A session that cannot persist a setting still has to be playable at it.
  }
}

/** What the master gain was hard-coded to before it could be changed. */
export const DEFAULT_VOLUME = 0.5;

/** The keys, in one place, so two modules cannot disagree about a name. */
export const KEY = {
  volume: "diomano.volume",
  muted: "diomano.muted",
  controls: "diomano.controls",
} as const;

/** A remembered 0..1 level. */
export function rememberedLevel(key: string, fallback: number): number {
  return remembered(
    key,
    (raw) => {
      const v = Number.parseFloat(raw);
      return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : null;
    },
    fallback,
  );
}

/** A remembered flag, written as "1" / "0". */
export function rememberedFlag(key: string, fallback: boolean): boolean {
  return remembered(key, (raw) => raw === "1", fallback);
}
