/**
 * The radial power menu. HANDOFF §8.
 *
 * A right-*click* on the planet (a press that neither strays nor lingers —
 * right-*drag* stays the camera orbit) opens a ring of the castable powers
 * around the cursor. Clicking a power casts it at the cell that was under the
 * cursor when the menu opened: the menu covers that ground, so the target is
 * snapshotted at open time rather than re-picked under the slices. Flood,
 * champion and armageddon ignore the target in the sim anyway.
 *
 * The menu is transient — it exists only between its right-click and its
 * close — which is the shape §8's "no HUD" leaves room for after the gesture
 * alphabet it originally described was retired in favour of this.
 *
 * Costs and enablement come from the wasm exports, not from mirrored tables:
 * a map manifest can change both, and a menu that promises what the sim then
 * refuses is worse than no menu. A slice the player cannot afford is greyed
 * live (the sim keeps ticking while the menu is open, so affordability can
 * change under it); clicking it is the same diegetic "no" as any refused
 * cast. Armageddon keeps its friction: it asks for a second, confirming
 * click — the 2-second hold it used to cost died with the gestures, and the
 * irreversible verb must not become the cheapest one to reach (§8).
 */

import type { Hand, Target } from "./hand";
import type { Sim } from "./main";
import { MOD, POWER, VERB, readModifier } from "./verbs";

/** The same click test the left button uses (hand.ts): slop and patience. */
const CLICK_SLOP_SQ = 5 * 5;
const CLICK_MAX_MS = 400;

/**
 * Distance from the open point to each slice's centre, in pixels.
 *
 * 120 was set against a 13px label in an 86px box. At the legible size the
 * boxes are ~120px wide, and six of them on a 120px ring have a 120px chord
 * between neighbours — they overlapped, which is half of why the menu was hard
 * to read at all. At 168 the tightest case (seven powers enabled) leaves a
 * 146px chord, so nothing touches.
 */
const RING_RADIUS = 168;

/** How long the armageddon confirm state waits for its second click. */
const CONFIRM_MS = 1500;

/** One castable power: its slice label, verb, and manifest index. */
interface Entry {
  verb: number;
  power: number;
  name: string;
  blurb: string;
}

/** Ordered by cost, so the ring reads as an escalation. German (Phase 9). */
const ENTRIES: Entry[] = [
  { verb: VERB.MAGNET, power: POWER.MAGNET, name: "Magnet", blurb: "Dein Volk folgt ihm." },
  {
    verb: VERB.EARTHQUAKE,
    power: POWER.EARTHQUAKE,
    name: "Beben",
    blurb: "Zerbricht den Boden — Siedlungen verfallen.",
  },
  {
    verb: VERB.SWAMP,
    power: POWER.SWAMP,
    name: "Sumpf",
    blurb: "Verschlingt Wanderer, die ihn betreten.",
  },
  {
    verb: VERB.VOLCANO,
    power: POWER.VOLCANO,
    name: "Vulkan",
    blurb: "Lava, die Land frisst und langsam erkaltet.",
  },
  {
    verb: VERB.FLOOD,
    power: POWER.FLOOD,
    name: "Flut",
    blurb: "Hebt den Meeresspiegel — überall, für immer.",
  },
  {
    verb: VERB.CHAMPION,
    power: POWER.CHAMPION,
    name: "Held",
    blurb: "Erhebt deinen stärksten Wanderer.",
  },
  {
    verb: VERB.ARMAGEDDON,
    power: POWER.ARMAGEDDON,
    name: "Armageddon",
    blurb: "Ruft sofort die letzte, größte Welle.",
  },
];

export interface Radial {
  /** Start listening for the opening right-click. Called once the match runs. */
  attach(): void;
  /** Per-frame refresh while open: affordability, charges, modifier line. */
  sync(): void;
  /** True while the menu is on screen (the camera does not care, but tests might). */
  readonly open: boolean;
}

export interface RadialActions {
  /** Push the chosen verb at the snapshotted cell. */
  cast(verb: number, modifier: number, target: Target): void;
  /** The diegetic "no": refusal sound and the hand's red flash. */
  refuse(): void;
}

export function createRadial(
  canvas: HTMLCanvasElement,
  sim: Sim,
  player: number,
  hand: Hand,
  actions: RadialActions,
): Radial {
  let backdrop: HTMLDivElement | null = null;
  let hub: HTMLDivElement | null = null;
  let slices: { el: HTMLDivElement; entry: Entry }[] = [];
  let target: Target | null = null;
  /** Modifier bits as currently held, mirrored into the hub line. */
  let mods = 0;
  /** Non-null while the armageddon slice waits for its confirming click. */
  let confirmUntil = 0;
  let hovered: Entry | null = null;
  /** Mana as last written into the hub, so `sync` only rewrites when it moves. */
  let hubMana = -1;

  // Right-button click detection, alongside the camera's right-drag orbit.
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let tracking = false;

  const close = (): void => {
    backdrop?.remove();
    backdrop = null;
    hub = null;
    slices = [];
    target = null;
    confirmUntil = 0;
    hovered = null;
    hubMana = -1;
    hand.setSuppressed(false);
  };

  const modLine = (): string => {
    const parts: string[] = [];
    if (mods & MOD.THROWN) parts.push("geworfen");
    if (mods & MOD.EXTREME) parts.push("extrem");
    else if (mods & MOD.INCREASED) parts.push("verstärkt");
    return parts.length > 0 ? parts.join(" · ") : "";
  };

  /**
   * The hub: what the hovered power does, which modifiers are held, and how much
   * mana there is to spend.
   *
   * The mana line is the one readout §8's "no HUD" leaves room for — it lives
   * inside a menu that exists only while it is held open. Without it every slice
   * quoted a price with nothing to compare it against: the palm's glow says
   * "roughly this much", which is enough to feel and useless for deciding
   * between a 260 and a 600.
   */
  const renderHub = (): void => {
    if (!hub) return;
    const blurb = hovered ? hovered.blurb : "Kraft wählen — Umschalt / Alt / Strg wandeln sie ab.";
    const line = modLine();
    hubMana = sim.e.dio_mana(player);
    hub.innerHTML =
      `${blurb}${line ? `<div class="mods">${line}</div>` : ""}` +
      `<div class="mana">${hubMana} Mana</div>`;
  };

  const affordable = (entry: Entry): boolean =>
    sim.e.dio_power_cost(entry.power) <= sim.e.dio_mana(player) ||
    sim.e.dio_free_uses(player, entry.power) > 0;

  /** What each slice last rendered, so `sync` rewrites only what moved. */
  const rendered = new WeakMap<HTMLDivElement, string>();

  const renderSlice = (el: HTMLDivElement, entry: Entry): void => {
    const cost = sim.e.dio_power_cost(entry.power);
    const charges = sim.e.dio_free_uses(player, entry.power);
    const confirming = entry.verb === VERB.ARMAGEDDON && performance.now() < confirmUntil;
    el.classList.toggle("disabled", !affordable(entry));
    el.classList.toggle("confirm", confirming);
    const label = confirming ? "Bestätigen?" : entry.name;
    const chargeMark =
      charges > 0 ? ` <span class="charge">●${charges > 1 ? charges : ""}</span>` : "";
    const html = `${label}<span class="cost">${cost} Mana${chargeMark}</span>`;
    // The same discipline the hub keeps: `innerHTML` at frame rate tears down
    // and re-parses the children sixty times a second for text that changes
    // once in a while.
    if (rendered.get(el) === html) return;
    rendered.set(el, html);
    el.innerHTML = html;
  };

  const openAt = (x: number, y: number, ev: MouseEvent): void => {
    const at = hand.target();
    if (!at) {
      // A menu opened over empty space would cast into nothing; same diegetic
      // refusal the gestures gave a stroke over the void.
      actions.refuse();
      return;
    }
    target = at;
    mods = readModifier(ev);
    // The target cell is snapshotted above, so the hand has nothing left to
    // show — and it is the brightest thing on screen, sitting exactly where the
    // labels are about to go.
    hand.setSuppressed(true);

    backdrop = document.createElement("div");
    backdrop.className = "radial";
    // Keep the whole ring on screen when opened near an edge.
    const margin = RING_RADIUS + 90;
    const cx = Math.min(Math.max(x, margin), innerWidth - margin);
    const cy = Math.min(Math.max(y, margin), innerHeight - margin);
    // Anchor the backdrop's scrim on the ring rather than on the screen centre.
    backdrop.style.setProperty("--cx", `${cx}px`);
    backdrop.style.setProperty("--cy", `${cy}px`);

    const shown = ENTRIES.filter((entry) => sim.e.dio_power_enabled(entry.power) !== 0);
    slices = shown.map((entry, i) => {
      const el = document.createElement("div");
      el.className = "radial-slice";
      // Slices start at 12 o'clock and walk clockwise, cheapest first.
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / shown.length;
      el.style.left = `${cx + Math.cos(angle) * RING_RADIUS}px`;
      el.style.top = `${cy + Math.sin(angle) * RING_RADIUS}px`;
      renderSlice(el, entry);
      el.addEventListener("pointerenter", () => {
        hovered = entry;
        renderHub();
      });
      el.addEventListener("pointerleave", () => {
        hovered = null;
        renderHub();
      });
      el.addEventListener("pointerdown", (pe) => {
        pe.stopPropagation();
        if (pe.button !== 0) return;
        if (!affordable(entry)) {
          actions.refuse();
          return;
        }
        if (entry.verb === VERB.ARMAGEDDON && performance.now() >= confirmUntil) {
          confirmUntil = performance.now() + CONFIRM_MS;
          renderSlice(el, entry);
          return;
        }
        if (target) actions.cast(entry.verb, readModifier(pe), target);
        close();
      });
      backdrop?.append(el);
      return { el, entry };
    });

    hub = document.createElement("div");
    hub.className = "radial-hub";
    hub.style.left = `${cx}px`;
    hub.style.top = `${cy}px`;
    renderHub();
    backdrop.append(hub);

    // Anything that reaches the backdrop itself is a close: left click beside
    // the slices, another right click, a wheel turn.
    backdrop.addEventListener("pointerdown", close);
    backdrop.addEventListener("contextmenu", (ce) => ce.preventDefault());
    backdrop.addEventListener("wheel", close, { passive: true });
    document.body.append(backdrop);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (backdrop && ev.key === "Escape") {
      close();
      return;
    }
    if (backdrop) {
      mods = modsFromKeys(ev);
      renderHub();
    }
  };
  const onKeyUp = (ev: KeyboardEvent): void => {
    if (backdrop) {
      mods = modsFromKeys(ev);
      renderHub();
    }
  };

  return {
    attach(): void {
      canvas.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 2) return;
        tracking = true;
        downX = ev.clientX;
        downY = ev.clientY;
        downT = performance.now();
      });
      canvas.addEventListener("pointerup", (ev) => {
        if (ev.button !== 2 || !tracking) return;
        tracking = false;
        const dx = ev.clientX - downX;
        const dy = ev.clientY - downY;
        const isClick =
          dx * dx + dy * dy < CLICK_SLOP_SQ && performance.now() - downT < CLICK_MAX_MS;
        if (isClick) openAt(ev.clientX, ev.clientY, ev);
      });
      addEventListener("keydown", onKeyDown);
      addEventListener("keyup", onKeyUp);
    },

    sync(): void {
      if (!backdrop) return;
      // The world moves on while the menu is open: mana accrues, charges get
      // spent, the confirm window runs out. Re-render from the live sim.
      for (const { el, entry } of slices) renderSlice(el, entry);
      // The hub costs an `innerHTML` write, so it is rebuilt only when the
      // number it shows actually moves — not sixty times a second.
      if (sim.e.dio_mana(player) !== hubMana) renderHub();
    },

    get open(): boolean {
      return backdrop !== null;
    },
  };
}

/** Modifier bits from a keyboard event's own modifier keys. */
function modsFromKeys(ev: KeyboardEvent): number {
  return (
    (ev.shiftKey ? MOD.THROWN : 0) |
    (ev.altKey ? MOD.INCREASED : 0) |
    (ev.ctrlKey ? MOD.EXTREME : 0)
  );
}
