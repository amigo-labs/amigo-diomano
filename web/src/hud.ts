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
 * bar to manage, and the panel is four lines in a corner.
 *
 * # Who is winning, said the way the match decides it
 *
 * The match is won on waves, not on territory: each wave's peak counts the
 * *habitable* cells under each god, and most waves won takes it. So the moment
 * a wave peaks the banner says that wave's count and who took it, and a row of
 * marks under the tide line keeps the tally — `●` a wave you won, `○` one you
 * lost, `·` one still to come. The territory bar counts the same cells the
 * score does (dry soil and rock above the sea), so the bar a player watches
 * between waves is the number that will be read out at the next one. It used
 * to count every influenced cell, beach and swamp and sea floor alike, and a
 * full bar could lose the wave.
 *
 * # What just happened, over there
 *
 * Not answered here: `renderer/indicators.ts` draws a pip at the planet's limb
 * toward anything off screen that matters. An attempt at it as screen-edge DOM
 * markers was withdrawn because it could not be shown to paint over the WebGL
 * canvas reliably, and the pips are drawn in the scene instead.
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
import type { WorldEvent } from "./worldEvents";

/**
 * Tide phase names, indexed by `dio_tide_phase()`. Mirrors `TIDE` in main.ts,
 * which cannot be imported for its value without making this module part of a
 * runtime cycle — the reason `verbs.ts` exists.
 */
const PHASE_NAME = ["Ruhig", "Welle rollt an", "Einschlag", "Rückzug", "Vorbei"] as const;
const PHASE_TELEGRAPH = 1;
const PHASE_IMPACT = 2;
const PHASE_RECOVERY = 3;
const PHASE_DONE = 4;

/** How long a banner stays up, in ms. */
const BANNER_MS = 2400;
/** A wave's result is the one banner worth reading twice. */
const SCORE_BANNER_MS = 4200;

/** Ticks between territory samples. Influence moves over seconds, not frames. */
const TERRITORY_EVERY = 10;

/** Every Nth column of every Nth row of each face is sampled for the territory bar. */
const TERRITORY_STRIDE = 3;

/** Materials the score counts as habitable. Mirrors `MAT_ROCK` / `MAT_SOIL` in `world.rs`. */
const MAT_ROCK = 0;
const MAT_SOIL = 2;

/** Delay before the first coaching hint, and between hints, in ms. */
const HINT_DELAY_MS = 6000;
const HINT_STEP_MS = 9000;

/** Fewest ms between two "a settlement of yours fell" banners. */
const FELL_BANNER_GAP_MS = 30000;

/** How a single wave went, from the local player's side. */
export type WaveResult = "won" | "lost" | "draw";

export interface HudOptions {
  /** A wave just peaked and was scored; the caller plays the sting. */
  onWaveScored?(result: WaveResult): void;
}

export interface Hud {
  /**
   * Per-frame refresh. `events` are the verbs the simulation *applied* this
   * frame — the same list `effects.ts` and the audio feedback read, so a
   * coaching hint retires on what the sim did and not on what was asked for.
   * `world` is this frame's population diff (`worldEvents.ts`).
   */
  sync(events: readonly VerbEventView[], world: readonly WorldEvent[]): void;
  /** A transient centred line: tide phases, volume changes. */
  banner(text: string): void;
  /**
   * Put the last banner back up and keep it for `ms`. For the tools: a capture
   * on a software renderer under load can take longer than a banner lives, and
   * the frame it waits for is the one that takes the banner down.
   */
  holdBanner(ms: number): void;
  /** Called when the radial menu opens, so the third coaching hint can retire. */
  noteMenuOpened(): void;
  /** Hide everything while an overlay owns the screen. */
  setVisible(on: boolean): void;
  /** Re-arm the coaching hints, for a restart. */
  reset(): void;
}

/**
 * Something a new player has to be told once, and whether the event that
 * proves they no longer need telling has happened. The title card lists the
 * controls; a card read thirty seconds ago is not the same as a prompt at the
 * moment of doubt.
 */
interface Hint {
  text: string;
  done: boolean;
}

export function createHud(sim: Sim, player: number, options: HudOptions = {}): Hud {
  const root = document.createElement("div");
  root.className = "hud hud-hidden";
  // A static template — no interpolation reaches this, and the values below are
  // written with `textContent`.
  root.innerHTML = `
    <div class="hud-panel">
      <div class="hud-mana"><b>0</b> Mana</div>
      <div class="hud-tide">Welle 1 · Ruhig</div>
      <div class="hud-waves"></div>
      <div class="hud-doom"></div>
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
  const wavesLine = root.querySelector<HTMLElement>(".hud-waves")!;
  const doomLine = root.querySelector<HTMLElement>(".hud-doom")!;
  const bar = root.querySelector<HTMLElement>(".hud-bar i")!;
  const bannerEl = root.querySelector<HTMLElement>(".hud-banner")!;
  const hintEl = root.querySelector<HTMLElement>(".hud-hint")!;
  const controlsEl = root.querySelector<HTMLElement>(".hud-controls")!;

  let controlsShown = rememberedFlag(KEY.controls, false);
  const applyControls = (): void => {
    controlsEl.classList.toggle("shown", controlsShown);
    // The card *is* the whole control list, so a coaching line naming one
    // binding has nothing left to teach while it is open — and the two of them
    // sit in the same corner of the frame: the hint is centred with a 30em
    // width and the card is bottom-right, so the longer hints overlapped the
    // card's own "F1 schließt diese Übersicht" line.
    if (controlsShown) hintEl.classList.remove("shown");
    else hintEl.classList.toggle("shown", shownHint !== null);
  };

  // Last written values, so a frame that changed nothing touches no DOM. Sixty
  // layout invalidations a second for a number that moves once a tick is the
  // kind of cost that only shows up on the §7.6 reference floor.
  let shownMana = -1;
  let shownTide = "";
  let shownTally = "";
  let shownShare = -1;
  let shownHint: Hint | null = null;
  let shownDoom = -1;
  applyControls();

  let bannerUntil = 0;
  let lastPhase = -1;
  /** `dio_tide_scored` last frame; -1 until the first frame of a match has read it. */
  let lastScored = -1;
  let territoryShare = 0.5;
  let lastTerritoryTick = -TERRITORY_EVERY;
  /** Whether "your people founded a settlement" has been said this match. */
  let foundedSaid = false;
  let lastFellBanner = -FELL_BANNER_GAP_MS;

  // The timed sequence, in the order they are worth learning. Each retires the
  // moment the player does the thing; see `sync` for the stagger.
  const levelHint: Hint = {
    text: "Ebne Land neben deinem Dorf — auf flachem Boden baut dein Volk.",
    done: false,
  };
  const magnetHint: Hint = {
    text: "Linksklick setzt den Magneten — dein Volk folgt ihm.",
    done: false,
  };
  const menuHint: Hint = { text: "Rechtsklick oder Leertaste öffnet das Kraftmenü.", done: false };
  const helpHint: Hint = { text: "F1 zeigt die ganze Steuerung.", done: false };
  const sequence: readonly Hint[] = [levelHint, magnetHint, menuHint, helpHint];
  /**
   * Not timed: shown when the first wave's telegraph begins, over whatever the
   * sequence had up, and retired when the wave lands. The flood line it names
   * is drawn by the terrain shader for exactly that window. Retired on the
   * tide's clock, not the wall's: the telegraph is thirty seconds of
   * simulation, and a wall-clock cap either cut it short on a slow machine or
   * outlived it on a fast one.
   */
  const waveHint: Hint = {
    text: "Die Welle kommt: Land unter der schraffierten Linie geht unter.",
    done: false,
  };
  /** Whether the first telegraph has begun, so `waveHint` is due. */
  let waveHintArmed = false;
  /** When the hud first became visible, which is when the match actually began. */
  let armedAt = 0;

  // F1 is the key everybody tries; `?` is the one everybody else tries. F1 also
  // opens the browser's own help, so it has to be claimed explicitly.
  addEventListener("keydown", (ev) => {
    if (ev.key !== "F1" && ev.key !== "?") return;
    ev.preventDefault();
    // A held key auto-repeats at the typing rate, and every repeat flipped the
    // card: it flickered and came to rest wherever the release happened to fall.
    if (ev.repeat) return;
    controlsShown = !controlsShown;
    remember(KEY.controls, controlsShown ? "1" : "0");
    applyControls();
    helpHint.done = true;
  });

  /**
   * Share of the ground the wave score counts that is under the local player's
   * influence — sampled rather than summed, exactly as `audio.ts` samples
   * erosion: 24,576 live cells is too many to walk every frame, and the number
   * this feeds is a bar 90 pixels wide.
   *
   * "The ground the score counts" is `World::habitable`: above the current sea,
   * soil or rock, no standing water. Mirrored here rather than exported because
   * it is three comparisons on views this already has.
   *
   * The walk goes face by face through `sim.idx`, striding both axes, so it is a
   * lattice of live cells and never touches the ghost ring. A single stride over
   * the flat index used to divide the 66-cell row pitch and therefore visited the
   * same five columns of every row — one of them a ghost column — and none of
   * the other fifty-nine.
   */
  const sampleTerritory = (): number => {
    const sea = sim.e.dio_sea_level();
    let mine = 0;
    let theirs = 0;
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < sim.N; y += TERRITORY_STRIDE) {
        for (let x = 0; x < sim.N; x += TERRITORY_STRIDE) {
          const c = sim.idx(face, x, y);
          const v = sim.influence[c] ?? 0;
          if (v === 0) continue;
          const material = sim.material[c];
          if (
            (sim.height[c] ?? 0) <= sea ||
            (material !== MAT_SOIL && material !== MAT_ROCK) ||
            (sim.water[c] ?? 0) !== 0
          ) {
            continue;
          }
          if (v > 0 === (player === 0)) mine += 1;
          else theirs += 1;
        }
      }
    }
    const total = mine + theirs;
    return total > 0 ? mine / total : 0.5;
  };

  const showBanner = (text: string, tone = "", ms = BANNER_MS): void => {
    bannerEl.textContent = text;
    bannerEl.classList.remove("won", "lost");
    if (tone) bannerEl.classList.add(tone);
    bannerEl.classList.add("shown");
    bannerUntil = performance.now() + ms;
  };

  /** How wave `w` went, or null while it has not been scored. */
  const waveState = (w: number, phase: number): WaveResult | "skipped" | null => {
    const current = sim.e.dio_tide_wave();
    const scored =
      w < current || (w === current && (sim.e.dio_tide_scored() !== 0 || phase === PHASE_DONE));
    if (!scored) return null;
    const mine = sim.e.dio_score(player, w);
    const theirs = sim.e.dio_score(1 - player, w);
    // Armageddon jumps to the last wave: the ones it skipped never peaked.
    if (mine === 0 && theirs === 0) return "skipped";
    return mine > theirs ? "won" : theirs > mine ? "lost" : "draw";
  };

  const TALLY_MARK = { won: "●", lost: "○", draw: "◐", skipped: "–", pending: "·" } as const;

  const renderTally = (phase: number, waves: number): void => {
    const states: (keyof typeof TALLY_MARK)[] = [];
    for (let w = 0; w < waves; w++) states.push(waveState(w, phase) ?? "pending");
    const key = states.join(",");
    if (key === shownTally) return;
    shownTally = key;
    wavesLine.replaceChildren(
      ...states.map((s) => {
        const mark = document.createElement("span");
        mark.className = s;
        mark.textContent = TALLY_MARK[s];
        return mark;
      }),
    );
  };

  return {
    sync(events: readonly VerbEventView[], world: readonly WorldEvent[]): void {
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
      renderTally(phase, waves);

      // The tide's phase changes, announced. §8 forbids a countdown and this is
      // not one: it says what just happened, once, and fades.
      if (phase !== lastPhase) {
        if (lastPhase >= 0) {
          if (phase === PHASE_TELEGRAPH) showBanner(`Welle ${shownWave} rollt an`);
          else if (phase === PHASE_IMPACT) showBanner("Einschlag");
          else if (phase === PHASE_RECOVERY) showBanner("Das Wasser weicht zurück");
        }
        if (phase === PHASE_TELEGRAPH) waveHintArmed = true;
        lastPhase = phase;
      }

      // The wave's peak: the score is in. Staged on the sim's own flag rather
      // than on the phase clock, so a wave summoned early by armageddon is read
      // out the same way.
      const scored = sim.e.dio_tide_scored();
      if (lastScored === 0 && scored !== 0) {
        const mine = sim.e.dio_score(player, wave);
        const theirs = sim.e.dio_score(1 - player, wave);
        const result: WaveResult = mine > theirs ? "won" : theirs > mine ? "lost" : "draw";
        const verdict =
          result === "won" ? "gewonnen" : result === "lost" ? "verloren" : "unentschieden";
        showBanner(
          `Welle ${wave + 1} · ${mine} : ${theirs} — ${verdict}`,
          result === "draw" ? "" : result,
          SCORE_BANNER_MS,
        );
        options.onWaveScored?.(result);
      }
      lastScored = scored;

      // Sudden death's grace window, your own only (docs/specs/pacing.md):
      // a rescue nobody can see is only a delay. The opponent's would be a
      // victory readout, and §8 is spent sparingly. Whole seconds left, so the
      // DOM is touched once a second and not once a frame.
      const doom = sim.e.dio_doom_ticks(player);
      const left =
        doom > 0 ? Math.ceil((sim.e.dio_grace_ticks() - doom) / sim.e.dio_tick_hz()) : -1;
      if (left !== shownDoom) {
        if (shownDoom < 0 && left >= 0) showBanner("Dein Volk verliert den Boden");
        shownDoom = left;
        doomLine.textContent = left >= 0 ? `Dein Volk hat kein Land mehr — ${left} s` : "";
        doomLine.classList.toggle("shown", left >= 0);
      }

      // Your own people's news, when nothing louder is being said. The first
      // settlement founded *after the player has shaped the ground* is the
      // payoff of the first hint — the simulation founds a ring of villages
      // round each core on its first tick, and announcing those would be
      // praise for nothing. A settlement lost outside a wave's impact is
      // someone's doing and worth a look, once the opening tour is over. A
      // wave takes coastlines by the dozen and already has its banner.
      const quiet = now >= bannerUntil;
      const settled = armedAt > 0 && now - armedAt > HINT_DELAY_MS;
      for (const ev of world) {
        if (!quiet || (ev.kind !== "founded" && ev.kind !== "fell")) continue;
        if (ev.owner !== player) continue;
        if (ev.kind === "founded" && levelHint.done && !foundedSaid) {
          foundedSaid = true;
          showBanner("Dein Volk gründet ein neues Dorf");
          break;
        }
        if (
          ev.kind === "fell" &&
          settled &&
          phase !== PHASE_IMPACT &&
          now - lastFellBanner >= FELL_BANNER_GAP_MS
        ) {
          lastFellBanner = now;
          showBanner("Ein Dorf ist gefallen");
          break;
        }
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
        if (ev.verb === VERB.RAISE || ev.verb === VERB.LOWER) levelHint.done = true;
        else if (ev.verb === VERB.MAGNET) magnetHint.done = true;
      }
      // The first wave's hint interrupts the sequence for as long as the wave
      // is coming, and then is spent; the sequence picks up where it was.
      if (waveHintArmed && phase !== PHASE_TELEGRAPH) waveHint.done = true;
      let due: Hint | null = null;
      if (armedAt > 0) {
        if (waveHintArmed && !waveHint.done) {
          due = waveHint;
        } else {
          const pending = sequence.findIndex((h) => !h.done);
          if (pending >= 0 && now - armedAt > HINT_DELAY_MS + pending * HINT_STEP_MS) {
            due = sequence[pending] ?? null;
          }
        }
      }
      if (due !== shownHint) {
        shownHint = due;
        hintEl.textContent = due?.text ?? "";
        hintEl.classList.toggle("shown", due !== null && !controlsShown);
      }
    },

    banner: (text: string) => showBanner(text),

    holdBanner(ms: number): void {
      bannerEl.classList.add("shown");
      bannerUntil = performance.now() + ms;
    },

    noteMenuOpened(): void {
      menuHint.done = true;
    },

    setVisible(on: boolean): void {
      root.classList.toggle("hud-hidden", !on);
      if (on && armedAt === 0) armedAt = performance.now();
    },

    reset(): void {
      for (const h of sequence) h.done = false;
      waveHint.done = false;
      waveHintArmed = false;
      shownHint = null;
      hintEl.classList.remove("shown");
      hintEl.textContent = "";
      shownMana = -1;
      shownTide = "";
      shownTally = "";
      shownShare = -1;
      shownDoom = -1;
      doomLine.textContent = "";
      doomLine.classList.remove("shown");
      lastPhase = -1;
      lastScored = -1;
      foundedSaid = false;
      lastFellBanner = -FELL_BANNER_GAP_MS;
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
