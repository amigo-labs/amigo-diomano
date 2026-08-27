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
 *
 * # Why the match is not in this file
 *
 * This module is the page's entry point, and the entry point must be *small*.
 * It imports no three.js and no renderer: it puts the title card on screen,
 * then `import()`s `./game`, which is where the WebGL context, the world mesh
 * and the audio graph get built. Vite already emits three.js as its own chunk
 * (`manualChunks` in `vite.config.ts`), so that chunk is now fetched and parsed
 * *behind* a card the player is already reading rather than in front of it.
 *
 * Every renderer module imports `Sim` from here with `import type`, which erases
 * at compile time — so none of them drags three.js back into this chunk.
 */

import type { Game, GameOptions } from "./game";
import { DEFAULT_VOLUME, KEY, remember, rememberedLevel } from "./storage";
import { type VolumeControl, createUi } from "./ui";

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
  dio_mesh_attribs3_ptr(): number;
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
  dio_power_enabled(power: number): number;
  dio_power_cost(power: number): number;
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
  /** Stable across ticks, which is what lets the renderer track one figure. */
  id: number;
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
  /** Per vertex: rock, sand, soil, ash weights. Swamp is the remainder. */
  readonly meshAttribs3: Uint8Array;
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

  /**
   * Reused `WalkerView` objects. See `walkers()` for why.
   *
   * `walkerPool` grows to the high-water mark and never shrinks; `walkerLive` is
   * the array handed back, refilled on each call so its length is the live count.
   */
  const walkerPool: WalkerView[] = [];
  const walkerLive: WalkerView[] = [];

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
    meshAttribs3: new Uint8Array(buf, e.dio_mesh_attribs3_ptr(), totalVerts * 4),
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
      // Written into a pool rather than allocated.
      //
      // This used to build up to 1,024 object literals *every tick* — 30,000
      // short-lived objects a second, for data that is already sitting in wasm
      // memory in exactly the layout wanted. The views are read and discarded by
      // the caller within the same frame, so reusing them costs nothing and the
      // garbage costs a collection. It is the same argument `cellDirectionInto`
      // makes for vectors.
      //
      // The returned array is *live*: the next call rewrites it. No caller keeps
      // one past the frame it asked for.
      let n = 0;
      for (let i = 0; i < maxWalkers; i++) {
        const o = i * walkerStride;
        const flags = walkerBytes.getUint8(o + WALKER.FLAGS);
        if ((flags & 1) === 0) continue;
        let view = walkerPool[n];
        if (!view) {
          view = { id: 0, x: 0, y: 0, hp: 0, face: 0, owner: 0, strength: 0, flags: 0 };
          walkerPool[n] = view;
        }
        view.id = walkerBytes.getUint16(o + WALKER.ID, true);
        view.x = walkerBytes.getInt32(o + WALKER.X, true) / 65536;
        view.y = walkerBytes.getInt32(o + WALKER.Y, true) / 65536;
        view.hp = walkerBytes.getInt16(o + WALKER.HP, true);
        view.face = walkerBytes.getUint8(o + WALKER.FACE);
        view.owner = walkerBytes.getUint8(o + WALKER.OWNER);
        view.strength = walkerBytes.getUint8(o + WALKER.STRENGTH);
        view.flags = flags;
        n += 1;
      }
      walkerLive.length = 0;
      for (let i = 0; i < n; i++) walkerLive.push(walkerPool[i]!);
      return walkerLive;
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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Put the card up first, then load the game behind it.
 *
 * The old order was the other way round — `await loadSim(...)`, build every
 * renderer layer, *then* show the title card — so the page was black for the
 * whole of it. Nothing above the card's own click needs the simulation, so
 * nothing above it waits for one.
 */
function boot(): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#stage");
  const fallback = document.querySelector<HTMLDivElement>("#fallback");
  if (!canvas || !fallback) throw new Error("page is missing its canvas");

  const params = new URLSearchParams(location.search);
  const options: GameOptions = {
    seed: Number.parseInt(params.get("seed") ?? "0x5EED", 16) || 0x5eed,
    terrain: Number.parseInt(params.get("terrain") ?? "0", 10) || 0,
    tier: params.get("tier") === "1" ? 1 : 2,
    ai: params.get("ai") !== "0",
  };

  // The slider is live before the audio graph exists — the card is on screen
  // within a frame and `AudioContext` cannot be created until the player
  // clicks. Until `game` arrives the level is only remembered; `createAudio`
  // then reads the same key back out of storage, so nothing is lost.
  let game: Game | null = null;
  let pendingVolume = rememberedLevel(KEY.volume, DEFAULT_VOLUME);
  const volume: VolumeControl = {
    get: () => game?.audio.volume() ?? pendingVolume,
    set: (v) => {
      if (game) {
        game.audio.setVolume(v);
        return;
      }
      pendingVolume = Math.min(Math.max(v, 0), 1);
      remember(KEY.volume, String(pendingVolume));
    },
  };

  const ui = createUi();
  const card = ui.showTitle(volume);

  void (async () => {
    try {
      // Both halves at once: the wasm is a network fetch and the game chunk is
      // a parse, and neither needs the other to start.
      const [module, sim] = await Promise.all([
        import("./game"),
        loadSim("/diomano.wasm", options.seed, options.terrain, options.ai),
      ]);
      game = module.startGame(canvas, sim, options, ui);
      card.markReady();
      await card.started;
      game.begin();
    } catch (err) {
      canvas.style.display = "none";
      fallback.style.display = "grid";
      fallback.textContent =
        err instanceof Error ? `diomano could not start.\n\n${err.message}` : String(err);
      throw err;
    }
  })();
}

// The replay harness (`tools/replay.html`) instantiates the wasm itself, but a
// future tool importing this module for `loadSim` must not get a game as a side
// effect.
if (!location.pathname.startsWith("/tools/")) {
  boot();
}
