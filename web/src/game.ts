/**
 * The match: renderer, input, audio and the fixed-step loop. HANDOFF §9.4.
 *
 * Split out of `main.ts` so that **nothing here is on the path to the first
 * paint**. `main.ts` shows the title card and then `import()`s this module, so
 * the three.js chunk, the WebGL context, the world mesh and the audio graph are
 * all built behind a card the player is already reading. Before the split,
 * `boot()` awaited the wasm and built every renderer layer *before* the card
 * existed, and the page was black for as long as that took.
 *
 * `startGame` returns as soon as the world is standing and rendering idly
 * behind the card. `begin()` is the second half, and it needs the player's
 * click: that click is the activation gesture the browsers require before audio
 * may make a sound, and ticking before anyone is looking hands the scripted
 * opponent a free lead.
 */

import * as THREE from "three";
import { type Audio, createAudio } from "./audio";
import { createCamera } from "./camera";
import { createHand } from "./hand";
import { createHud } from "./hud";
import { createLoop } from "./loop";
import { type QualityTier, type Sim, TIDE, type VerbEventView } from "./main";
import { createRadial } from "./radial";
import { createAtmosphere } from "./renderer/atmosphere";
import { createEffects } from "./renderer/effects";
import { cellDirection, createPlanet } from "./renderer/planet";
import { createPost } from "./renderer/post";
import { createVegetation } from "./renderer/vegetation";
import { createView } from "./renderer/view";
import { createWater } from "./renderer/water";
import type { Ui } from "./ui";
import { VERB } from "./verbs";

/** The god the local player is. Player 1 is the scripted opponent for now. */
const LOCAL_PLAYER = 0;

/** What the URL asked for, parsed once in `main.ts` and passed down. */
export interface GameOptions {
  seed: number;
  terrain: number;
  tier: QualityTier;
  ai: boolean;
}

export interface Game {
  /** The audio graph, so the title card's volume slider can reach the real thing. */
  readonly audio: Audio;
  /**
   * Start the match. Called from the title card's click, which is also the
   * activation gesture the browsers require before audio may make a sound.
   */
  begin(): void;
}

export function startGame(canvas: HTMLCanvasElement, sim: Sim, options: GameOptions, ui: Ui): Game {
  const { terrain, tier, ai } = options;
  let currentSeed = options.seed;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // FXAA in post instead (§7.3); cheaper on integrated GPUs
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  // ACES tone mapping and subtle bloom (§7.3 tier 1).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  // Every shader's shared values live in one place; see `renderer/view.ts` for
  // the three features that broke when they were per-material copies.
  const view = createView();
  const camera = createCamera(canvas);
  const planet = createPlanet(sim, view);
  const water = createWater(sim, view);
  const atmosphere = createAtmosphere(view);
  const vegetation = createVegetation(sim, tier, view);
  planet.material.uniforms.uTier!.value = tier;
  water.material.uniforms.uTier!.value = tier;
  scene.add(planet.group, water.mesh, atmosphere.group, vegetation.group);

  const post = createPost(renderer, scene, camera.camera, tier);
  const audio = createAudio();
  // The readouts §8 did not allow for, and the reason the deviation was worth
  // it — see the header of `hud.ts` and the note in PLAN.md.
  const hud = createHud(sim, LOCAL_PLAYER);

  // Volume, finally reachable: a slider on the title card and three keys in
  // the match. The banner is the feedback — a level you cannot hear changing
  // (because you set it during a quiet stretch) has to say so on screen.
  addEventListener("keydown", (ev) => {
    // "=" as well as "+": on a US layout the plus needs shift, and a player
    // reaching for it without one should still get louder.
    if (ev.key === "+" || ev.key === "=") audio.setVolume(audio.volume() + 0.1);
    else if (ev.key === "-") audio.setVolume(audio.volume() - 0.1);
    else if (ev.key === "m" || ev.key === "M") audio.toggleMute();
    else return;
    hud.banner(audio.muted() ? "Stumm" : `Lautstärke ${Math.round(audio.volume() * 100)}%`);
  });

  // Truthful cast feedback. A push is only a *request*: the sim may refuse
  // it on cost or availability, and the old optimistic confirm played the
  // swamp's sound for a power the manifest disables. So every tracked cast
  // waits for its own verb-event — written past the sim's gating — and a
  // cast whose event never arrives gets an audible refusal instead.
  const pendingCasts: { verb: number; deadline: number }[] = [];
  const trackCast = (verb: number): void => {
    pendingCasts.push({ verb, deadline: sim.e.dio_tick_count() + 4 });
  };

  const hand = createHand(sim, camera, canvas, LOCAL_PLAYER, trackCast);
  const effects = createEffects(sim);
  scene.add(hand.group, effects.group);
  /** High-water mark in the simulation's verb-event ring. */
  let seenVerbEvents = sim.e.dio_verb_events_written() >>> 0;
  // The power menu replaces the gesture recogniser: a right-*click* (right-
  // *drag* stays the orbit) opens a radial menu at the cursor, and a chosen
  // power casts at the cell that was under the cursor when it opened.
  const radial = createRadial(canvas, sim, LOCAL_PLAYER, hand, {
    cast(verb, modifier, target) {
      sim.push(LOCAL_PLAYER, verb, target.face, target.x, target.y, modifier);
      trackCast(verb);
    },
    refuse() {
      audio.refusal();
      hand.flash();
    },
  });

  const applySize = (): void => {
    // Re-read the device pixel ratio every time: dragging a window between a 1x and
    // a 2x display fires `resize` without changing `innerWidth`, and a stale
    // ratio renders the whole frame at the wrong resolution.
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.resize(innerWidth / innerHeight);
    post.resize(innerWidth, innerHeight);
  };
  addEventListener("resize", applySize);
  applySize();

  // The sim is gated behind the title card: the planet renders idle behind
  // the overlay, but ticks only start once the player is actually looking —
  // otherwise the opponent builds a lead against someone reading the
  // controls.
  let matchStarted = false;
  /** Non-zero once the end card has been handled; mirrors `dio_outcome`. */
  let handledOutcome = 0;

  /** Local-player verbs whose one-shot only plays when the sim applied them. */
  const consumeVerbFeedback = (events: VerbEventView[]): void => {
    const tick = sim.e.dio_tick_count();
    for (const ev of events) {
      if (ev.player === LOCAL_PLAYER) {
        if (ev.verb === VERB.RAISE || ev.verb === VERB.LOWER) {
          audio.sculpt();
          continue;
        }
        const i = pendingCasts.findIndex((p) => p.verb === ev.verb);
        if (i >= 0) {
          pendingCasts.splice(i, 1);
          audio.verbSfx(ev.verb);
        }
      } else if (ev.verb !== VERB.RAISE && ev.verb !== VERB.LOWER && ev.verb !== VERB.SET_HAND) {
        // The opponent's casts, quieter. This is how the other god becomes
        // audible — the client sees its own commands but never theirs, so
        // the applied-verb ring is the only source (§ effects, same idea).
        audio.verbSfx(ev.verb, 0.4);
      }
    }
    // Casts the sim never applied: refused on cost, or a disabled power.
    for (let i = pendingCasts.length - 1; i >= 0; i--) {
      const p = pendingCasts[i];
      if (p && tick > p.deadline) {
        pendingCasts.splice(i, 1);
        audio.refusal();
        hand.flash();
      }
    }
  };

  const restart = (newSeed: boolean): void => {
    const nextSeed = newSeed ? (Math.random() * 0xffffffff) >>> 0 : currentSeed;
    currentSeed = nextSeed;
    // Keep the match shareable: the seed lives in the URL either way.
    const url = new URL(location.href);
    url.searchParams.set("seed", nextSeed.toString(16));
    history.replaceState(null, "", url);
    // In-place re-init: `World::init` starts from `zeroed()` and memory
    // never grows, so every view stays valid — and the AudioContext stays
    // unlocked, which a page reload would lose.
    sim.e.dio_init(nextSeed, terrain, ai ? 1 : 0);
    seenVerbEvents = sim.e.dio_verb_events_written() >>> 0;
    pendingCasts.length = 0;
    handledOutcome = 0;
    // `dio_init` re-meshes, but its dirty flags are cleared inside the next
    // `meshUpdate` before `sync` reads them and the content hashes then
    // match — without a full re-upload the screen keeps the dead world.
    sim.meshUpdate();
    planet.refreshAll();
    water.refreshAll();
    camera.drift(0);
    ui.hide();
    hud.reset();
    hud.setVisible(true);
  };

  const onMatchEnd = (outcome: number): void => {
    handledOutcome = outcome;
    // The epilogue tableau is the frozen planet, not a readout of a match that
    // is over.
    hud.setVisible(false);
    audio.sting(outcome === 1 ? "win" : outcome === 2 ? "loss" : "draw");
    // The frozen planet is the epilogue tableau; drift it slowly and let the
    // sting land before the card comes up.
    camera.drift(0.05);
    const waves: { mine: number; theirs: number }[] = [];
    const waveCount = Math.min(sim.e.dio_wave_count(), 16);
    for (let wave = 0; wave < waveCount; wave++) {
      waves.push({
        mine: sim.e.dio_score(LOCAL_PLAYER, wave),
        theirs: sim.e.dio_score(1 - LOCAL_PLAYER, wave),
      });
    }
    // `decide_match` fires exactly when the tide reaches DONE; any outcome
    // set before that is sudden death (§5.5) — derived here rather than
    // exported, because the sim already says it through the tide phase.
    const cause = {
      suddenDeath: sim.e.dio_tide_phase() !== TIDE.DONE,
      wave: sim.e.dio_tide_wave(),
    };
    setTimeout(() => {
      if (handledOutcome !== 0) ui.showGameOver(outcome, waves, cause, restart);
    }, 2500);
  };

  /** Edge detector for the radial menu, so a hint retires the first time. */
  let menuWasOpen = false;

  const loop = createLoop({
    update() {
      if (!matchStarted) return;
      hand.beforeTick();
      sim.tick();
    },
    render(alpha, dtMs) {
      // The camera goes first. Everything below reads its matrix — the shared
      // view uniforms, the hand's pick ray, the trail's unprojection — and
      // running it last meant all of them used the previous frame's view. With
      // 71 ms of orbit smoothing that lag is visible as the cursor sliding
      // behind the terrain during a drag.
      camera.update(dtMs);
      const tick = sim.e.dio_tick_count();
      view.sync(camera.camera, tick, dtMs);

      sim.meshUpdate();
      planet.sync(sim.e.dio_sea_level());
      water.sync();
      vegetation.sync(tick);
      hand.sync(alpha);
      radial.sync();
      // Effects read what the simulation *applied*, so the opponent's powers
      // are visible too and a power refused on cost throws nothing.
      const fired = sim.verbEvents(seenVerbEvents);
      seenVerbEvents = fired.written;
      consumeVerbFeedback(fired.events);
      camera.shake(effects.sync(sim, fired.events, dtMs));
      // The same applied-verb list the effects and the sounds read, so a
      // coaching hint retires on what the simulation did.
      hud.sync(fired.events);
      if (radial.open && !menuWasOpen) hud.noteMenuOpened();
      menuWasOpen = radial.open;
      atmosphere.sync(
        sim.e.dio_tide_phase(),
        sim.e.dio_ticks_to_impact(),
        sim.e.dio_tide_offset(),
        sim.e.dio_tide_strength(),
      );
      audio.sync(sim, dtMs);

      // The match result, finally read by someone. The sim freezes itself
      // once the outcome is decided; the client's job is the presentation.
      const outcome = sim.e.dio_outcome();
      if (outcome !== 0 && handledOutcome === 0) onMatchEnd(outcome);

      post.render();
    },
  });

  // A development handle. There is no HUD and no debug overlay (§8), so the
  // only way to interrogate a running world is from the console — and being
  // able to hide one layer at a time is what turns "the planet looks wrong"
  // into a diagnosis.
  (window as unknown as { diomano: unknown }).diomano = {
    sim,
    renderer,
    scene,
    planet,
    water,
    atmosphere,
    vegetation,
    camera,
    view,
    effects,
    radial,
  };

  // Honest tab handling: a hidden tab pauses the world instead of silently
  // deleting up to a minute of simulation on return (the catch-up cap drops
  // whatever rAF starvation accumulated). `loop.start` resets the
  // accumulator, so resuming produces no burst.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      loop.stop();
      void audio.suspend();
    } else {
      loop.start();
      if (matchStarted) void audio.resume();
    }
  });

  // The planet turns idly behind the card from here on; ticking waits for the
  // click that calls `begin`.
  loop.start();
  camera.drift(0.03);

  return {
    audio,

    begin(): void {
      // The title click is the browsers' required activation gesture: unlock
      // audio here and nothing is lost.
      void audio.resume();
      camera.drift(0);
      matchStarted = true;
      radial.attach();
      hud.setVisible(true);

      // A one-time tour: two seconds on the opponent's spawn — the other god
      // exists, acts, and its first lessons are audible — then an eased pan
      // home. Any input cancels it. Directions come from the settlements the
      // sim seeded, so this survives any future spawn change.
      const homes = sim.settlements();
      const dirOf = (owner: number): THREE.Vector3 | null => {
        const own = homes.filter((s) => s.owner === owner);
        if (own.length === 0) return null;
        const acc = new THREE.Vector3();
        for (const s of own) acc.add(cellDirection(s.face, s.x, s.y, sim.N));
        return acc.normalize();
      };
      const enemyDir = dirOf(1 - LOCAL_PLAYER);
      const homeDir = dirOf(LOCAL_PLAYER);
      if (enemyDir && homeDir) {
        camera.aimAt(enemyDir, true);
        setTimeout(() => camera.intro(homeDir, 4500), 2000);
      }
    },
  };
}
