/**
 * WebAssembly binding and application bootstrap. HANDOFF §9.3, §9.4.
 *
 * # The boundary
 *
 * Rust owns every byte of simulation state in linear memory. TypeScript holds
 * *views* over `memory.buffer` obtained from pointer getters, and nothing is
 * ever serialised across the boundary. One `tick()` call per tick, never one
 * call per entity.
 *
 * Memory is pre-allocated and never grows, which is what makes those views safe
 * to build once at load: growing wasm memory detaches every existing view, and
 * the failure mode is silent garbage rather than an exception. The Rust side
 * enforces this by linking no allocator at all.
 *
 * There is no `wasm-bindgen` and no generated glue. `WebAssembly.instantiateStreaming`
 * plus a table of `extern "C"` functions is the entire loader, which is why this
 * file is the only place that knows the module exists.
 */

import * as THREE from "three";
import { createAudio } from "./audio";
import { createCamera } from "./camera";
import { createGestures } from "./gestures";
import { createHand } from "./hand";
import { createLoop } from "./loop";
import { createAtmosphere } from "./renderer/atmosphere";
import { createEffects } from "./renderer/effects";
import { cellDirection, createPlanet } from "./renderer/planet";
import { createPost } from "./renderer/post";
import { createTrail } from "./renderer/trail";
import { createVegetation } from "./renderer/vegetation";
import { createView } from "./renderer/view";
import { createWater } from "./renderer/water";
import { createUi } from "./ui";

// ---------------------------------------------------------------------------
// Verbs and modifiers
//
// Mirrors of the constants in `crates/diomano-sim/src/world.rs`. They are not
// exported from wasm one getter each because that would be forty exports to
// avoid one comment; `assertLayout` below checks the things that actually
// change silently (grid size, struct strides) at load time.
// ---------------------------------------------------------------------------

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

export const TIDE = { CALM: 0, TELEGRAPH: 1, IMPACT: 2, RECOVERY: 3, DONE: 4 } as const;

/** Quality tiers of §7.3. Tier 3 is out of scope for this run. */
export type QualityTier = 1 | 2;

interface RawExports {
  memory: WebAssembly.Memory;
  dio_init(seed: number, terrain: number, ai: number): void;
  dio_tick(): void;
  dio_push_command(
    player: number,
    verb: number,
    face: number,
    x: number,
    y: number,
    modifier: number,
  ): void;
  dio_mesh_update(): number;

  dio_height_ptr(): number;
  dio_water_ptr(): number;
  dio_lava_ptr(): number;
  dio_material_ptr(): number;
  dio_fertility_ptr(): number;
  dio_vegetation_ptr(): number;
  dio_sediment_ptr(): number;
  dio_influence_ptr(): number;
  dio_erode_ptr(): number;
  dio_walkers_ptr(): number;
  dio_settlements_ptr(): number;
  dio_pickups_ptr(): number;

  dio_mesh_positions_ptr(): number;
  dio_mesh_normals_ptr(): number;
  dio_mesh_attribs_ptr(): number;
  dio_mesh_water_positions_ptr(): number;
  dio_mesh_attribs2_ptr(): number;
  dio_mesh_water_attribs_ptr(): number;
  dio_mesh_indices_ptr(): number;
  dio_mesh_dirty_ptr(): number;
  dio_mesh_water_present_ptr(): number;

  dio_grid_n(): number;
  dio_grid_stride(): number;
  dio_cell_count(): number;
  dio_max_walkers(): number;
  dio_max_settlements(): number;
  dio_max_pickups(): number;
  dio_pickup_stride(): number;
  dio_verb_event_capacity(): number;
  dio_verb_event_stride(): number;
  dio_walker_stride(): number;
  dio_settlement_stride(): number;
  dio_chunk_cells(): number;
  dio_chunk_count(): number;
  dio_verts_per_chunk(): number;
  dio_indices_per_chunk(): number;
  dio_total_verts(): number;
  dio_tick_hz(): number;

  dio_tick_count(): number;
  dio_sea_level(): number;
  dio_tide_phase(): number;
  dio_tide_wave(): number;
  dio_tide_offset(): number;
  dio_tide_strength(): number;
  dio_ticks_to_impact(): number;
  dio_mana(player: number): number;
  dio_hand_amount(player: number): number;
  dio_hand_material(player: number): number;
  dio_hand_capacity(): number;
  dio_walker_count(player: number): number;
  dio_magnet_active(player: number): number;
  dio_magnet_face(player: number): number;
  dio_magnet_x(player: number): number;
  dio_magnet_y(player: number): number;
  dio_free_uses(player: number, power: number): number;
  dio_outcome(): number;
  dio_wave_count(): number;
  dio_score(player: number, wave: number): number;
  dio_state_hash_lo(): number;
  dio_state_hash_hi(): number;

  dio_verb_events_ptr(): number;
  dio_verb_events_written(): number;

  dio_log_ptr(): number;
  dio_log_capacity(): number;
  dio_replay(len: number): number;
  dio_replay_hashes_ptr(): number;
  dio_replay_hash_count(): number;
}

/** Offsets into the `#[repr(C)] Walker` struct in `world.rs`. */
const WALKER = {
  X: 0,
  Y: 4,
  HP: 8,
  ID: 10,
  HOME: 12,
  FACE: 14,
  OWNER: 15,
  STRENGTH: 16,
  FLAGS: 17,
};
/** Offsets into the `#[repr(C)] Pickup` struct in `world.rs`. */
const PICKUP = { FACE: 0, X: 1, Y: 2, POWER: 3, FLAGS: 4 };
/** Offsets into the `#[repr(C)] VerbEvent` struct in `world.rs`. */
const VERB_EVENT = { FACE: 0, X: 1, Y: 2, VERB: 3, PLAYER: 4, MODIFIER: 5, RADIUS: 6 };
/** Offsets into the `#[repr(C)] Settlement` struct in `world.rs`. */
const SETTLEMENT = {
  PROGRESS: 0,
  FACE: 4,
  X: 5,
  Y: 6,
  SIZE: 7,
  TIER: 8,
  OWNER: 9,
  POP: 10,
  FLAGS: 11,
};

export interface WalkerView {
  /** Q16.16 position within the face, already converted to cells. */
  x: number;
  y: number;
  face: number;
  owner: number;
  strength: number;
  hp: number;
  flags: number;
}

export interface PickupView {
  face: number;
  x: number;
  y: number;
  power: number;
}

/** One applied verb, for the effects renderer. */
export interface VerbEventView {
  face: number;
  x: number;
  y: number;
  verb: number;
  player: number;
  modifier: number;
  /** Brush radius in cells, so an effect can be the size of what it came from. */
  radius: number;
}

export interface SettlementView {
  face: number;
  x: number;
  y: number;
  size: number;
  tier: number;
  owner: number;
  pop: number;
}

export interface Sim {
  readonly e: RawExports;
  readonly N: number;
  readonly S: number;
  readonly cells: number;
  readonly chunkCells: number;
  readonly chunks: number;
  readonly vertsPerChunk: number;
  readonly indicesPerChunk: number;
  readonly totalVerts: number;

  readonly height: Int16Array;
  readonly water: Int16Array;
  readonly lava: Uint8Array;
  readonly material: Uint8Array;
  readonly fertility: Uint8Array;
  readonly vegetation: Uint8Array;
  readonly sediment: Uint8Array;
  readonly influence: Int8Array;
  readonly erode: Uint8Array;

  readonly meshPositions: Float32Array;
  readonly meshNormals: Float32Array;
  readonly meshAttribs: Uint8Array;
  /** Per vertex: lava depth, fertility, sediment, spare. */
  readonly meshAttribs2: Uint8Array;
  readonly waterPositions: Float32Array;
  readonly waterAttribs: Uint8Array;
  readonly meshIndices: Uint16Array;
  readonly meshDirty: Uint8Array;
  readonly meshWaterPresent: Uint8Array;

  /** Flat index of a live cell — the §3.2 formula, mirrored. */
  idx(face: number, x: number, y: number): number;
  tick(): void;
  meshUpdate(): number;
  push(player: number, verb: number, face: number, x: number, y: number, modifier: number): void;
  walkers(): WalkerView[];
  settlements(): SettlementView[];
  pickups(): PickupView[];
  /**
   * Verbs applied since `sinceWritten`, oldest first, plus the new high-water
   * mark. The caller keeps the mark and passes it back.
   *
   * Reads a ring the simulation writes and never reads, so this cannot influence
   * anything: it is the render side's only way to learn that the *opponent* cast
   * something, since the client sees its own commands but not theirs.
   */
  verbEvents(sinceWritten: number): { events: VerbEventView[]; written: number };
  stateHash(): bigint;
}

/**
 * Fetch, instantiate and wrap the simulation module.
 *
 * `instantiateStreaming` compiles while the bytes arrive, which is worth having
 * for a 200 KB module and free to ask for.
 */
export async function loadSim(
  url: string,
  seed: number,
  terrain: number,
  ai: boolean,
): Promise<Sim> {
  const imports: WebAssembly.Imports = {};
  let instance: WebAssembly.Instance;
  const response = fetch(url);
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(response, imports));
  } catch {
    // Some static hosts serve .wasm as application/octet-stream, which
    // `instantiateStreaming` rejects. Falling back keeps the page working
    // rather than making the deployment target a correctness question.
    const bytes = await (await fetch(url)).arrayBuffer();
    ({ instance } = await WebAssembly.instantiate(bytes, imports));
  }

  const e = instance.exports as unknown as RawExports;
  e.dio_init(seed, terrain, ai ? 1 : 0);

  const buf = e.memory.buffer;
  const N = e.dio_grid_n();
  const S = e.dio_grid_stride();
  const cells = e.dio_cell_count();
  const totalVerts = e.dio_total_verts();
  const chunks = e.dio_chunk_count();
  const vertsPerChunk = e.dio_verts_per_chunk();
  const indicesPerChunk = e.dio_indices_per_chunk();

  assertLayout(e, N, S, cells, chunks, vertsPerChunk, totalVerts);

  const maxWalkers = e.dio_max_walkers();
  const walkerStride = e.dio_walker_stride();
  const maxSettlements = e.dio_max_settlements();
  const settlementStride = e.dio_settlement_stride();
  const walkerBytes = new DataView(buf, e.dio_walkers_ptr(), maxWalkers * walkerStride);
  const settlementBytes = new DataView(
    buf,
    e.dio_settlements_ptr(),
    maxSettlements * settlementStride,
  );
  const maxPickups = e.dio_max_pickups();
  const pickupStride = e.dio_pickup_stride();
  const pickupBytes = new DataView(buf, e.dio_pickups_ptr(), maxPickups * pickupStride);
  const verbEventCapacity = e.dio_verb_event_capacity();
  const verbEventStride = e.dio_verb_event_stride();
  const verbEventBytes = new DataView(
    buf,
    e.dio_verb_events_ptr(),
    verbEventCapacity * verbEventStride,
  );

  const sim: Sim = {
    e,
    N,
    S,
    cells,
    chunkCells: e.dio_chunk_cells(),
    chunks,
    vertsPerChunk,
    indicesPerChunk,
    totalVerts,

    height: new Int16Array(buf, e.dio_height_ptr(), cells),
    water: new Int16Array(buf, e.dio_water_ptr(), cells),
    lava: new Uint8Array(buf, e.dio_lava_ptr(), cells),
    material: new Uint8Array(buf, e.dio_material_ptr(), cells),
    fertility: new Uint8Array(buf, e.dio_fertility_ptr(), cells),
    vegetation: new Uint8Array(buf, e.dio_vegetation_ptr(), cells),
    sediment: new Uint8Array(buf, e.dio_sediment_ptr(), cells),
    influence: new Int8Array(buf, e.dio_influence_ptr(), cells),
    erode: new Uint8Array(buf, e.dio_erode_ptr(), cells),

    meshPositions: new Float32Array(buf, e.dio_mesh_positions_ptr(), totalVerts * 3),
    meshNormals: new Float32Array(buf, e.dio_mesh_normals_ptr(), totalVerts * 3),
    meshAttribs: new Uint8Array(buf, e.dio_mesh_attribs_ptr(), totalVerts * 4),
    meshAttribs2: new Uint8Array(buf, e.dio_mesh_attribs2_ptr(), totalVerts * 4),
    waterPositions: new Float32Array(buf, e.dio_mesh_water_positions_ptr(), totalVerts * 3),
    waterAttribs: new Uint8Array(buf, e.dio_mesh_water_attribs_ptr(), totalVerts * 4),
    meshIndices: new Uint16Array(buf, e.dio_mesh_indices_ptr(), indicesPerChunk),
    meshDirty: new Uint8Array(buf, e.dio_mesh_dirty_ptr(), chunks),
    meshWaterPresent: new Uint8Array(buf, e.dio_mesh_water_present_ptr(), chunks),

    idx: (face, x, y) => (face * S + (y + 1)) * S + (x + 1),
    tick: () => e.dio_tick(),
    meshUpdate: () => e.dio_mesh_update(),
    push: (player, verb, face, x, y, modifier) =>
      e.dio_push_command(player, verb, face, x, y, modifier),

    walkers(): WalkerView[] {
      const out: WalkerView[] = [];
      for (let i = 0; i < maxWalkers; i++) {
        const o = i * walkerStride;
        const flags = walkerBytes.getUint8(o + WALKER.FLAGS);
        if ((flags & 1) === 0) continue;
        out.push({
          x: walkerBytes.getInt32(o + WALKER.X, true) / 65536,
          y: walkerBytes.getInt32(o + WALKER.Y, true) / 65536,
          hp: walkerBytes.getInt16(o + WALKER.HP, true),
          face: walkerBytes.getUint8(o + WALKER.FACE),
          owner: walkerBytes.getUint8(o + WALKER.OWNER),
          strength: walkerBytes.getUint8(o + WALKER.STRENGTH),
          flags,
        });
      }
      return out;
    },

    settlements(): SettlementView[] {
      const out: SettlementView[] = [];
      for (let i = 0; i < maxSettlements; i++) {
        const o = i * settlementStride;
        if ((settlementBytes.getUint8(o + SETTLEMENT.FLAGS) & 1) === 0) continue;
        out.push({
          face: settlementBytes.getUint8(o + SETTLEMENT.FACE),
          x: settlementBytes.getUint8(o + SETTLEMENT.X),
          y: settlementBytes.getUint8(o + SETTLEMENT.Y),
          size: settlementBytes.getUint8(o + SETTLEMENT.SIZE),
          tier: settlementBytes.getUint8(o + SETTLEMENT.TIER),
          owner: settlementBytes.getUint8(o + SETTLEMENT.OWNER),
          pop: settlementBytes.getUint8(o + SETTLEMENT.POP),
        });
      }
      return out;
    },

    pickups(): PickupView[] {
      const out: PickupView[] = [];
      for (let i = 0; i < maxPickups; i++) {
        const o = i * pickupStride;
        if ((pickupBytes.getUint8(o + PICKUP.FLAGS) & 1) === 0) continue;
        out.push({
          face: pickupBytes.getUint8(o + PICKUP.FACE),
          x: pickupBytes.getUint8(o + PICKUP.X),
          y: pickupBytes.getUint8(o + PICKUP.Y),
          power: pickupBytes.getUint8(o + PICKUP.POWER),
        });
      }
      return out;
    },

    verbEvents(sinceWritten: number): { events: VerbEventView[]; written: number } {
      const written = e.dio_verb_events_written() >>> 0;
      const events: VerbEventView[] = [];
      if (written === sinceWritten) return { events, written };
      // Clamp to the ring: a caller more than a full ring behind has lost the
      // oldest events, and reading them anyway would replay stale ones as new.
      const first = Math.max(sinceWritten, written - verbEventCapacity);
      for (let seq = first; seq < written; seq++) {
        const o = (seq % verbEventCapacity) * verbEventStride;
        events.push({
          face: verbEventBytes.getUint8(o + VERB_EVENT.FACE),
          x: verbEventBytes.getUint8(o + VERB_EVENT.X),
          y: verbEventBytes.getUint8(o + VERB_EVENT.Y),
          verb: verbEventBytes.getUint8(o + VERB_EVENT.VERB),
          player: verbEventBytes.getUint8(o + VERB_EVENT.PLAYER),
          modifier: verbEventBytes.getUint8(o + VERB_EVENT.MODIFIER),
          radius: verbEventBytes.getUint8(o + VERB_EVENT.RADIUS),
        });
      }
      return { events, written };
    },

    stateHash(): bigint {
      return (BigInt(e.dio_state_hash_hi() >>> 0) << 32n) | BigInt(e.dio_state_hash_lo() >>> 0);
    },
  };

  return sim;
}

/**
 * Check the things that break silently.
 *
 * A grid size or struct stride that drifts between Rust and TypeScript produces
 * a view that is merely misaligned — no exception, no crash, just terrain that
 * looks like static. Failing loudly at load is cheap insurance.
 */
function assertLayout(
  e: RawExports,
  N: number,
  S: number,
  cells: number,
  chunks: number,
  vertsPerChunk: number,
  totalVerts: number,
): void {
  const problems: string[] = [];
  if (S !== N + 2) problems.push(`stride ${S} is not N + 2 for N = ${N}`);
  if (cells !== 6 * S * S) problems.push(`cell count ${cells} is not 6 * ${S}^2`);
  if (totalVerts !== chunks * vertsPerChunk) {
    problems.push(`vertex count ${totalVerts} is not ${chunks} * ${vertsPerChunk}`);
  }
  if (e.dio_tick_hz() !== 30) problems.push(`tick rate is ${e.dio_tick_hz()}, expected 30`);
  if (e.dio_walker_stride() !== 20) {
    problems.push(`Walker stride is ${e.dio_walker_stride()}, but main.ts reads 20-byte records`);
  }
  if (e.dio_settlement_stride() !== 12) {
    problems.push(
      `Settlement stride is ${e.dio_settlement_stride()}, but main.ts reads 12-byte records`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`wasm/TS layout mismatch:\n  ${problems.join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** The god the local player is. Player 1 is the scripted opponent for now. */
const LOCAL_PLAYER = 0;

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#stage");
  const fallback = document.querySelector<HTMLDivElement>("#fallback");
  if (!canvas || !fallback) throw new Error("page is missing its canvas");

  try {
    const params = new URLSearchParams(location.search);
    const seed = Number.parseInt(params.get("seed") ?? "0x5EED", 16) || 0x5eed;
    const terrain = Number.parseInt(params.get("terrain") ?? "0", 10) || 0;
    const tier: QualityTier = params.get("tier") === "1" ? 1 : 2;
    const ai = params.get("ai") !== "0";
    let currentSeed = seed;

    const sim = await loadSim("/diomano.wasm", seed, terrain, ai);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // FXAA in post instead (§7.3); cheaper on integrated GPUs
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight, false);
    // ACES tone mapping and subtle bloom (§7.3 tier 1).
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    // Every shader's shared values live in one place; see `renderer/view.ts` for
    // the three features that broke when they were per-material copies.
    const view = createView();
    // Set by the gesture recogniser and read by the camera, so a spiral takes
    // the stroke away from the orbit control instead of sharing it.
    const gestureArmed = { value: false };
    const camera = createCamera(canvas, gestureArmed);
    const planet = createPlanet(sim, view);
    const water = createWater(sim, view);
    const atmosphere = createAtmosphere(view);
    const vegetation = createVegetation(sim, tier, view);
    planet.material.uniforms.uTier!.value = tier;
    water.material.uniforms.uTier!.value = tier;
    scene.add(planet.group, water.mesh, atmosphere.group, vegetation.group);

    const post = createPost(renderer, scene, camera.camera, tier);
    const audio = createAudio();
    const ui = createUi();

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
    const trail = createTrail();
    const effects = createEffects(sim);
    scene.add(hand.group, trail.object, effects.group);
    /** High-water mark in the simulation's verb-event ring. */
    let seenVerbEvents = sim.e.dio_verb_events_written() >>> 0;
    const gestures = createGestures(
      canvas,
      (verb, modifier) => {
        const target = hand.target();
        if (!target) {
          // A gesture drawn over empty space used to vanish silently.
          audio.refusal();
          hand.flash();
          return;
        }
        sim.push(LOCAL_PLAYER, verb, target.face, target.x, target.y, modifier);
        trackCast(verb);
      },
      gestureArmed,
    );

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
            audio.gesture(ev.verb);
          }
        } else if (ev.verb !== VERB.RAISE && ev.verb !== VERB.LOWER && ev.verb !== VERB.SET_HAND) {
          // The opponent's casts, quieter. This is how the other god becomes
          // audible — the client sees its own commands but never theirs, so
          // the applied-verb ring is the only source (§ effects, same idea).
          audio.gesture(ev.verb, 0.4);
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
    };

    const onMatchEnd = (outcome: number): void => {
      handledOutcome = outcome;
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
      setTimeout(() => {
        if (handledOutcome !== 0) ui.showGameOver(outcome, waves, restart);
      }, 2500);
    };

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
        trail.sync(camera.camera, gestures.stroke, gestures.armed);
        // Effects read what the simulation *applied*, so the opponent's powers
        // are visible too and a power refused on cost throws nothing.
        const fired = sim.verbEvents(seenVerbEvents);
        seenVerbEvents = fired.written;
        consumeVerbFeedback(fired.events);
        camera.shake(effects.sync(sim, fired.events, dtMs));
        atmosphere.sync(sim.e.dio_tide_phase(), sim.e.dio_ticks_to_impact());
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
      trail,
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

    // Render first — the planet turns idly behind the title card — and only
    // start ticking and listening for gestures once the player clicks through.
    loop.start();
    camera.drift(0.03);
    await ui.showTitle();
    // The title click is the browsers' required activation gesture: unlock
    // audio here and nothing is lost.
    void audio.resume();
    camera.drift(0);
    matchStarted = true;
    gestures.start();

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
  } catch (err) {
    canvas.style.display = "none";
    fallback.style.display = "grid";
    fallback.textContent =
      err instanceof Error ? `diomano could not start.\n\n${err.message}` : String(err);
    throw err;
  }
}

// The replay harness (`tools/verify-cross.mjs`) loads this module for `loadSim`
// and must not get a game as a side effect.
if (!location.pathname.startsWith("/tools/")) {
  void boot();
}
