/**
 * The readouts that tell you what is happening. HANDOFF §8, with a deviation.
 *
 * # §8 says there is no HUD, and that turned out to cost too much
 *
 * > No HUD. The god has no body, only a hand — cursor, matter carrier and
 * > influence indicator in one.
 *
 * The hand is a good interface and it is not an instrument panel. Played
 * through, the match had no way to answer four questions it constantly poses:
 *
 * - **How much mana do I have?** The palm glows brighter with mana, which is
 *   enough to feel and useless for choosing between a 260 and a 600. The radial
 *   menu now says the number while it is open; this says it always.
 * - **Where are we in the match?** Seven tide waves decide the outcome and the
 *   only cues were a wind bed and an atmospheric rim. Which wave, and how many
 *   were left, were unanswerable.
 * - **Who is winning?** §7.4's "the planet is the scoreboard" is true of the
 *   colour mood at a territory boundary, and it does not survive a camera
 *   pointed at your own coastline. The end card was the first honest answer.
 *
 * So: a small permanent panel, and a transient banner for the tide's own phase
 * changes. The deviation is deliberate and recorded in PLAN.md. What §8 was
 * protecting — a screen that is mostly planet, and verbs you feel rather than
 * read — is untouched: nothing here is interactive, nothing here is a resource
 * bar to manage, and the panel is three lines in a corner.
 *
 * # A fourth question this does *not* answer
 *
 * **What just happened, over there?** `effects.ts` draws every applied verb as
 * particles *in the world*, so a power that lands off screen or on the far side
 * of the planet is still indistinguishable from one that never fired — the exact
 * problem `effects.ts` exists to fix, solved only for the half of the sphere you
 * happen to be looking at.
 *
 * Screen-edge DOM markers were built for it and then withdrawn, because they
 * could not be shown to work. The element was in the document with the right
 * position, `visibility: visible`, `opacity: 1` and an opaque background, and it
 * did not appear in a capture; `waitForSelector` would match one and the very
 * next round-trip would find it gone, which no 2.6-second lifetime explains.
 * Pooling the nodes, restricting them to the frame edge and casting on the far
 * side each changed nothing. One early capture did show one, which makes it
 * worse rather than better: the mechanism can paint and nobody knows what
 * decides it.
 *
 * The next attempt should draw the indicator in the 3D scene, where everything
 * else that must be seen is already drawn (`effects.ts` has the instancing and
 * the projection), rather than in a DOM layer over a WebGL canvas.
 *
 * # The controls card
 *
 * The title card lists the bindings once, thirty seconds before the player
 * needs any of them. `F1` (or `?`) puts the same table back on screen during
 * the match and takes it away again, and the choice is remembered. It is off by
 * default, so nothing about the resting screen changes: this is a reference
 * card the player asks for, not a fourth readout. Both it and the title card
 * render the one `CONTROLS` table in `verbs.ts` — they used to keep separate
 * copies, and the copies drifted.
 *
 * Plain DOM over the canvas, system fonts, no assets, `pointer-events: none`
 * throughout, like the rest of the shell. Player-facing strings are German
 * (Phase 9); code and comments stay English.
 */

import type { Sim, VerbEventView } from "./main";
import { KEY, remember, rememberedFlag } from "./storage";
import { CONTROLS, VERB } from "./verbs";

/**
 * Tide phase names, indexed by `dio_tide_phase()`. Mirrors `TIDE` in main.ts,
 * which cannot be imported for its value without making this module part of a
 * runtime cycle — the reason `verbs.ts` exists.
 */
const PHASE_NAME = ["Ruhig", "Welle rollt an", "Einschlag", "Rückzug", "Vorbei"] as const;
const PHASE_TELEGRAPH = 1;
const PHASE_IMPACT = 2;
const PHASE_RECOVERY = 3;

/** How long a banner stays up, in ms. */
const BANNER_MS = 2400;

/** Ticks between territory samples. Influence moves over seconds, not frames. */
const TERRITORY_EVERY = 10;

/** Every Nth cell is sampled for the territory bar. */
const TERRITORY_STRIDE = 11;

/** Delay before the first coaching hint, and between hints, in ms. */
const HINT_DELAY_MS = 6000;
const HINT_STEP_MS = 9000;

export interface Hud {
  /**
   * Per-frame refresh. `events` are the verbs the simulation *applied* this
   * frame — the same list `effects.ts` and the audio feedback read, so a
   * coaching hint retires on what the sim did and not on what was asked for.
   */
  sync(events: readonly VerbEventView[]): void;
  /** A transient centred line: tide phases, volume changes. */
  banner(text: string): void;
  /** Called when the radial menu opens, so the third coaching hint can retire. */
  noteMenuOpened(): void;
  /** Hide everything while an overlay owns the screen. */
  setVisible(on: boolean): void;
  /** Re-arm the coaching hints, for a restart. */
  reset(): void;
}

/**
 * The three things a new player has to be told once, and the event that proves
 * they no longer need telling. The title card lists the controls; a card read
 * thirty seconds ago is not the same as a prompt at the moment of doubt.
 */
interface Hint {
  text: string;
  done: boolean;
}

export function createHud(sim: Sim, player: number): Hud {
  const root = document.createElement("div");
  root.className = "hud hud-hidden";
  // A static template — no interpolation reaches this, and the values below are
  // written with `textContent`.
  root.innerHTML = `
    <div class="hud-panel">
      <div class="hud-mana"><b>0</b> Mana</div>
      <div class="hud-tide">Welle 1 · Ruhig</div>
      <div class="hud-bar"><i></i></div>
    </div>
    <div class="hud-banner"></div>
    <div class="hud-hint"></div>
    <div class="hud-controls">
      <table></table>
      <p class="hud-controls-close">F1 schließt diese Übersicht</p>
    </div>`;
  document.body.append(root);

  // Built from `CONTROLS` rather than written into the template above, so the
  // table has exactly one source and adding a key needs one edit.
  const controlsTable = root.querySelector<HTMLTableElement>(".hud-controls table");
  if (controlsTable) {
    for (const [key, verb] of CONTROLS) {
      const row = controlsTable.insertRow();
      row.insertCell().textContent = key;
      row.insertCell().textContent = verb;
    }
  }

  const manaValue = root.querySelector<HTMLElement>(".hud-mana b")!;
  const tideLine = root.querySelector<HTMLElement>(".hud-tide")!;
  const bar = root.querySelector<HTMLElement>(".hud-bar i")!;
  const bannerEl = root.querySelector<HTMLElement>(".hud-banner")!;
  const hintEl = root.querySelector<HTMLElement>(".hud-hint")!;
  const controlsEl = root.querySelector<HTMLElement>(".hud-controls")!;

  let controlsShown = rememberedFlag(KEY.controls, false);
  const applyControls = (): void => {
    controlsEl.classList.toggle("shown", controlsShown);
  };
  applyControls();

  // Last written values, so a frame that changed nothing touches no DOM. Sixty
  // layout invalidations a second for a number that moves once a tick is the
  // kind of cost that only shows up on the §7.6 reference floor.
  let shownMana = -1;
  let shownTide = "";
  let shownShare = -1;
  let shownHint = -1;

  let bannerUntil = 0;
  let lastPhase = -1;
  let territoryShare = 0.5;
  let lastTerritoryTick = -TERRITORY_EVERY;

  const hints: Hint[] = [
    { text: "Links ziehen hebt und senkt Land.", done: false },
    { text: "Linksklick setzt den Magneten — dein Volk folgt ihm.", done: false },
    { text: "Rechtsklick öffnet das Kraftmenü.", done: false },
    { text: "F1 zeigt die ganze Steuerung.", done: false },
  ];
  /** When the hud first became visible, which is when the match actually began. */
  let armedAt = 0;

  // F1 is the key everybody tries; `?` is the one everybody else tries. F1 also
  // opens the browser's own help, so it has to be claimed explicitly.
  addEventListener("keydown", (ev) => {
    if (ev.key !== "F1" && ev.key !== "?") return;
    ev.preventDefault();
    controlsShown = !controlsShown;
    remember(KEY.controls, controlsShown ? "1" : "0");
    applyControls();
    hints[3]!.done = true;
  });

  /**
   * Share of claimed ground that is ours, 0..1.
   *
   * `influence` is `infl_acc[0] - infl_acc[1]` (flowfield.rs), so positive is
   * player 0 whichever god the local player is. Sampled with a stride rather
   * than summed, exactly as `audio.ts` samples erosion: 24,576 live cells is too
   * many to walk every frame, and the number this feeds is a bar 90 pixels wide.
   * The stride crosses the ghost ring, double-counting a few border cells — well
   * under one pixel at this resolution, and skipping them would mean mirroring
   * `world.rs`'s index arithmetic here for no visible gain.
   */
  const sampleTerritory = (): number => {
    let mine = 0;
    let theirs = 0;
    for (let c = 0; c < sim.cells; c += TERRITORY_STRIDE) {
      const v = sim.influence[c] ?? 0;
      if (v > 0) {
        if (player === 0) mine += 1;
        else theirs += 1;
      } else if (v < 0) {
        if (player === 0) theirs += 1;
        else mine += 1;
      }
    }
    const total = mine + theirs;
    return total > 0 ? mine / total : 0.5;
  };

  const showBanner = (text: string): void => {
    bannerEl.textContent = text;
    bannerEl.classList.add("shown");
    bannerUntil = performance.now() + BANNER_MS;
  };

  return {
    sync(events: readonly VerbEventView[]): void {
      const now = performance.now();

      const mana = sim.e.dio_mana(player);
      if (mana !== shownMana) {
        shownMana = mana;
        manaValue.textContent = String(mana);
      }

      const phase = sim.e.dio_tide_phase();
      const wave = sim.e.dio_tide_wave();
      const waves = sim.e.dio_wave_count();
      // Wave numbers are 0-based in the sim and 1-based for a person, and the
      // counter is clamped: the phase reaches DONE on the last wave, and
      // "Welle 8 / 7" would be the readout's only lie.
      const shownWave = Math.min(wave + 1, waves);
      const line = `Welle ${shownWave} / ${waves} · ${PHASE_NAME[phase] ?? ""}`;
      if (line !== shownTide) {
        shownTide = line;
        tideLine.textContent = line;
        tideLine.classList.toggle("warning", phase === PHASE_TELEGRAPH || phase === PHASE_IMPACT);
      }

      // The tide's phase changes, announced. §8 forbids a countdown and this is
      // not one: it says what just happened, once, and fades.
      if (phase !== lastPhase) {
        if (lastPhase >= 0) {
          if (phase === PHASE_TELEGRAPH) showBanner(`Welle ${shownWave} rollt an`);
          else if (phase === PHASE_IMPACT) showBanner("Einschlag");
          else if (phase === PHASE_RECOVERY) showBanner("Das Wasser weicht zurück");
        }
        lastPhase = phase;
      }

      const tick = sim.e.dio_tick_count();
      if (tick - lastTerritoryTick >= TERRITORY_EVERY) {
        lastTerritoryTick = tick;
        territoryShare = sampleTerritory();
      }
      const pct = Math.round(territoryShare * 100);
      if (pct !== shownShare) {
        shownShare = pct;
        bar.style.width = `${pct}%`;
      }

      if (now >= bannerUntil) bannerEl.classList.remove("shown");

      // Coaching: one hint at a time, each retiring the moment the player does
      // the thing, staggered so someone who works it out themselves never sees
      // the later ones.
      for (const ev of events) {
        if (ev.player !== player) continue;
        if (ev.verb === VERB.RAISE || ev.verb === VERB.LOWER) hints[0]!.done = true;
        else if (ev.verb === VERB.MAGNET) hints[1]!.done = true;
      }
      const pending = hints.findIndex((h) => !h.done);
      const due =
        armedAt > 0 && pending >= 0 && now - armedAt > HINT_DELAY_MS + pending * HINT_STEP_MS
          ? pending
          : -1;
      if (due !== shownHint) {
        shownHint = due;
        hintEl.textContent = due >= 0 ? (hints[due]?.text ?? "") : "";
        hintEl.classList.toggle("shown", due >= 0);
      }
    },

    banner: showBanner,

    noteMenuOpened(): void {
      const hint = hints[2];
      if (hint) hint.done = true;
    },

    setVisible(on: boolean): void {
      root.classList.toggle("hud-hidden", !on);
      if (on && armedAt === 0) armedAt = performance.now();
    },

    reset(): void {
      for (const h of hints) h.done = false;
      shownHint = -1;
      hintEl.classList.remove("shown");
      hintEl.textContent = "";
      shownMana = -1;
      shownTide = "";
      shownShare = -1;
      lastPhase = -1;
      armedAt = 0;
      // The tick is about to go back to zero. A sample stamp from the old match
      // would keep `tick - lastTerritoryTick` negative — and the bar showing the
      // previous match's territory — until the new match outlasted the old.
      lastTerritoryTick = -TERRITORY_EVERY;
      territoryShare = 0.5;
      bannerUntil = 0;
      bannerEl.classList.remove("shown");
    },
  };
}
