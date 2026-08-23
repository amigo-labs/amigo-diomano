/**
 * Shell UI: the title card and the end card. HANDOFF §9.4.
 *
 * §8's "no HUD" governs the match; §9.4 explicitly allows shell UI around it
 * (lobby, menus). These two overlays are that shell — the match itself still
 * renders nothing but the world. Plain DOM over the canvas, system fonts, no
 * frameworks, no assets. Player-facing strings are German (Phase 9); code and
 * comments stay English.
 */

export interface Ui {
  /** Show the title card. Resolves on the player's click, which is also the audio unlock. */
  showTitle(): Promise<void>;
  /** Show the end card: outcome, why it ended, per-wave score rows, restart buttons. */
  showGameOver(
    outcome: number,
    waves: { mine: number; theirs: number }[],
    cause: EndCause,
    onRestart: (newSeed: boolean) => void,
  ): void;
  hide(): void;
}

/**
 * Why the match ended. Sudden death (§5.5: a god's influence reached zero) and
 * the wave-score decision after the last recovery are different stories, and
 * the card should tell the right one — a player who never saw the enemy army
 * deserves to learn *what* ended their match, not just that it ended.
 */
export interface EndCause {
  /** True when the match ended by influence hitting zero, not by wave score. */
  suddenDeath: boolean;
  /** Wave the match ended during (0-based), for the sudden-death sentence. */
  wave: number;
}

const CONTROLS: [string, string][] = [
  ["Ziehen (links)", "Land heben / senken — die Hand füllt und leert sich"],
  ["Klick (links)", "Magnet setzen: dein Volk folgt ihm"],
  ["Ziehen (rechts)", "Planet drehen · Mausrad: Zoom"],
  ["Klick (rechts)", "Kraftmenü öffnen — Kräfte kosten Mana"],
  ["1 / 2 / 3", "Erde / Wasser / Lava greifen"],
  ["Umschalt / Alt / Strg", "geworfen / verstärkt / extrem"],
];

export function createUi(): Ui {
  let overlay: HTMLDivElement | null = null;

  const clear = (): void => {
    overlay?.remove();
    overlay = null;
  };

  const make = (): HTMLDivElement => {
    clear();
    overlay = document.createElement("div");
    overlay.className = "overlay";
    document.body.append(overlay);
    return overlay;
  };

  return {
    showTitle(): Promise<void> {
      const el = make();
      const rows = CONTROLS.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
      el.innerHTML = `
        <div>
          <h1>diomano</h1>
          <p class="premise">Zwei Götter, ein Planet. Wessen Volk übersteht die sieben Flutwellen?</p>
          <table>${rows}</table>
          <p class="hint">Klicken, um zu beginnen</p>
        </div>`;
      return new Promise((resolve) => {
        el.addEventListener(
          "pointerdown",
          () => {
            el.classList.add("overlay-hidden");
            // Remove after the fade so the canvas gets the pointer back.
            setTimeout(clear, 650);
            resolve();
          },
          { once: true },
        );
      });
    },

    showGameOver(
      outcome: number,
      waves: { mine: number; theirs: number }[],
      cause: EndCause,
      onRestart: (newSeed: boolean) => void,
    ): void {
      const el = make();
      const headline = outcome === 1 ? "Sieg" : outcome === 2 ? "Niederlage" : "Unentschieden";
      const causeLine = cause.suddenDeath
        ? outcome === 1
          ? `Das gegnerische Volk verlor während Welle ${cause.wave + 1} allen Einfluss.`
          : outcome === 2
            ? `Dein Volk verlor während Welle ${cause.wave + 1} allen Einfluss.`
            : "Beide Völker verloren zugleich allen Einfluss."
        : "Nach allen Wellen entschieden: Wer öfter am Wellenhöhepunkt mehr Land hielt, gewinnt.";
      // Only waves that were actually scored; a match decided by sudden death
      // before the first wave peak has nothing to tabulate, and seven rows of
      // "0 · 0" would say less than one honest sentence.
      const scored = waves.filter((w) => w.mine > 0 || w.theirs > 0);
      const rows = scored
        .map((w, i) => {
          const winner = w.mine > w.theirs ? "◂" : w.theirs > w.mine ? "▸" : "·";
          return `<tr><td>Welle ${i + 1}</td><td>${w.mine} ${winner} ${w.theirs}</td></tr>`;
        })
        .join("");
      const summary =
        scored.length > 0
          ? `<p class="premise">Gehaltenes Land am Höhepunkt jeder Welle — du ◂ · ▸ Gegner</p>
             <table>${rows}</table>`
          : `<p class="premise">Kein Wellenhöhepunkt wurde erreicht — nichts zu zählen.</p>`;
      el.innerHTML = `
        <div>
          <h1>${headline}</h1>
          <p class="premise">${causeLine}</p>
          ${summary}
          <p>
            <button data-restart="same">Nochmal spielen</button>
            <button data-restart="new">Neue Welt</button>
          </p>
        </div>`;
      for (const button of el.querySelectorAll("button")) {
        button.addEventListener("pointerdown", (ev) => {
          // The overlay itself must not treat this as a stray click anywhere.
          ev.stopPropagation();
          onRestart(button.dataset.restart === "new");
        });
      }
    },

    hide: clear,
  };
}
