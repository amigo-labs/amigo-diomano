//! World state, indexing, ghost borders, terrain generation and the tick loop.
//!
//! HANDOFF §3.2/§3.6/§3.7 and §4.1. Six square integer grids, one per cube face.
//! The sphere exists only in the renderer; nothing in this module knows about it.

use crate::hash::{Fnv64, Rng, hash3};
use crate::seams::{DIR_DX, DIR_DY, GHOST_DST, GHOST_ENTRIES, GHOST_SRC, step};
use crate::{ai, combat, flowfield, materials, powers, settlements, tide, walkers, water};

// ---------------------------------------------------------------------------
// Geometry (HANDOFF §3.2)
// ---------------------------------------------------------------------------

/// Cells per face edge.
///
/// A compile-time constant, not a runtime one: the simulation crate is `no_std`
/// with no allocation, so every field is a fixed-size array. A map manifest that
/// asks for a different `n` is rejected by the parser rather than silently
/// ignored (see [`crate::powers::parse_manifest`]).
///
/// Measured, not guessed — see `docs/specs/simulation.md` and
/// `cargo run -p diomano-cli -- perf`.
pub const N: usize = 64;
/// Stride: one cell of ghost border on each side (§3.4).
pub const S: usize = N + 2;
/// Cells per face, ghost border included.
pub const FACE_CELLS: usize = S * S;
/// Total addressable cells across all six faces.
pub const CELLS: usize = 6 * FACE_CELLS;
/// Live (non-ghost) cells.
pub const LIVE_CELLS: usize = 6 * N * N;

/// Flat index of a live cell. HANDOFF §3.2 verbatim.
#[inline]
#[must_use]
pub const fn idx(face: usize, x: usize, y: usize) -> usize {
    (face * S + (y + 1)) * S + (x + 1)
}

/// Flat index accepting the ghost ring, i.e. `x`/`y` in `-1..=N`.
#[inline]
#[must_use]
pub const fn idx_i(face: usize, x: i32, y: i32) -> usize {
    ((face as i32 * S as i32 + (y + 1)) * S as i32 + (x + 1)) as usize
}

/// Flat index of the neighbour one step in `dir`, staying within the same face's
/// storage block. For an edge cell this addresses the ghost ring, which the
/// ghost copy has already filled with the true neighbour's value.
#[inline]
#[must_use]
pub const fn neighbour_flat(c: usize, dir: usize) -> usize {
    // Ghost-ring arithmetic: +/-1 in x, +/-S in y. Never crosses a face block,
    // because every face block is padded by the ghost ring.
    let d = DIR_DX[dir] + DIR_DY[dir] * S as i32;
    (c as i32 + d) as usize
}

/// Flat index of the *real* neighbour one step in `dir`, following seams.
///
/// [`neighbour_flat`] is the hot-loop form and lands on the ghost ring at a face
/// boundary, which is exactly what the CA passes want. Graph traversals — BFS,
/// walkers — need the live cell instead, and pay a division for it.
#[inline]
#[must_use]
pub fn live_neighbour(c: usize, dir: usize) -> usize {
    let face = c / FACE_CELLS;
    let within = c % FACE_CELLS;
    let x = (within % S) as i32 - 1;
    let y = (within / S) as i32 - 1;
    let (f, nx, ny, _) = step(face, x, y, dir);
    idx_i(f, nx, ny)
}

/// Decode a live flat index back into `(face, x, y)`.
#[inline]
#[must_use]
pub const fn decode(c: usize) -> (usize, i32, i32) {
    let face = c / FACE_CELLS;
    let within = c % FACE_CELLS;
    (face, (within % S) as i32 - 1, (within / S) as i32 - 1)
}

// ---------------------------------------------------------------------------
// Units (HANDOFF §3.6)
// ---------------------------------------------------------------------------

/// One visible terrace.
pub const TERRACE: i16 = 16;
/// Deepest terrain the player can dig to.
pub const HEIGHT_MIN: i16 = -8192;
/// Highest terrain the player can raise to.
pub const HEIGHT_MAX: i16 = 8192;

// ---------------------------------------------------------------------------
// Materials (HANDOFF §3.7)
// ---------------------------------------------------------------------------

pub const MAT_ROCK: u8 = 0;
pub const MAT_SAND: u8 = 1;
pub const MAT_SOIL: u8 = 2;
pub const MAT_ASH: u8 = 3;
pub const MAT_SWAMP: u8 = 4;
pub const MAT_COUNT: usize = 5;

/// Bitmask over material ids, for the table-driven rules of §4.4.
#[inline]
#[must_use]
pub const fn mat_bit(m: u8) -> u32 {
    1u32 << m
}

// ---------------------------------------------------------------------------
// Capacities
// ---------------------------------------------------------------------------

/// Walkers per player (HANDOFF §4.5 `[START]` 512).
pub const WALKERS_PER_PLAYER: usize = 512;
pub const MAX_WALKERS: usize = WALKERS_PER_PLAYER * 2;
pub const MAX_SETTLEMENTS: usize = 256;
/// One-shot pickups lying on the terrain at once (§5.3).
pub const MAX_PICKUPS: usize = 16;
pub const MAX_WAVES: usize = 16;
pub const PLAYERS: usize = 2;
/// Sentinel for "no settlement occupies this cell".
pub const NO_SETTLEMENT: u16 = u16::MAX;
/// Sentinel for "no flow direction from this cell".
pub const NO_FLOW: u8 = 0xFF;

// ---------------------------------------------------------------------------
// Verbs (HANDOFF §5.1/§5.2)
// ---------------------------------------------------------------------------

pub const VERB_NOP: u8 = 0;
pub const VERB_RAISE: u8 = 1;
pub const VERB_LOWER: u8 = 2;
pub const VERB_MAGNET: u8 = 3;
pub const VERB_EARTHQUAKE: u8 = 4;
pub const VERB_SWAMP: u8 = 5;
pub const VERB_VOLCANO: u8 = 6;
pub const VERB_FLOOD: u8 = 7;
pub const VERB_CHAMPION: u8 = 8;
pub const VERB_ARMAGEDDON: u8 = 9;
pub const VERB_SET_HAND: u8 = 10;
pub const VERB_COUNT: u8 = 11;

/// Power ids, used to index [`MapConfig::power_enabled`] and `power_cost`.
pub const POWER_RAISE_LOWER: usize = 0;
pub const POWER_MAGNET: usize = 1;
pub const POWER_EARTHQUAKE: usize = 2;
pub const POWER_SWAMP: usize = 3;
pub const POWER_VOLCANO: usize = 4;
pub const POWER_FLOOD: usize = 5;
pub const POWER_CHAMPION: usize = 6;
pub const POWER_ARMAGEDDON: usize = 7;
pub const POWER_COUNT: usize = 8;

/// Map a verb onto the power that gates it.
#[inline]
#[must_use]
pub const fn verb_power(verb: u8) -> Option<usize> {
    match verb {
        VERB_RAISE | VERB_LOWER => Some(POWER_RAISE_LOWER),
        VERB_MAGNET => Some(POWER_MAGNET),
        VERB_EARTHQUAKE => Some(POWER_EARTHQUAKE),
        VERB_SWAMP => Some(POWER_SWAMP),
        VERB_VOLCANO => Some(POWER_VOLCANO),
        VERB_FLOOD => Some(POWER_FLOOD),
        VERB_CHAMPION => Some(POWER_CHAMPION),
        VERB_ARMAGEDDON => Some(POWER_ARMAGEDDON),
        _ => None,
    }
}

// Modifier bits (HANDOFF §5.3).
/// Thrown: large radius at the impact point. Clear means poured: small radius
/// directly under the hand.
pub const MOD_THROWN: u8 = 1 << 0;
/// Increased variant.
pub const MOD_INCREASED: u8 = 1 << 1;
/// Extreme variant (implies increased).
pub const MOD_EXTREME: u8 = 1 << 2;
/// For `VERB_SET_HAND`, the material to switch to is carried in the low bits of
/// `Command::x`; this bit is unused there.
pub const MOD_MASK: u8 = 0x3F;

// ---------------------------------------------------------------------------
// Hand (HANDOFF §4.2)
// ---------------------------------------------------------------------------

pub const HAND_EARTH: u8 = 0;
pub const HAND_WATER: u8 = 1;
pub const HAND_LAVA: u8 = 2;
/// `[START]` 4096 units per material.
pub const HAND_CAPACITY: u16 = 4096;

/// The hand is a pipette, not only a shovel (§4.2). Mixing is impossible:
/// picking up a second material requires depositing the first.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Hand {
    pub material: u8,
    pub _pad: u8,
    pub amount: u16,
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

pub const WALKER_ALIVE: u8 = 1 << 0;
pub const WALKER_LEADER: u8 = 1 << 1;
pub const WALKER_CHAMPION: u8 = 1 << 2;

/// Ceiling on the strength of a walker built by merging (§4.7, `balance-research`
/// TODO-8). `[START]`.
///
/// There is no sourced value for this and there cannot be: TODO-4 records that
/// walker strength was never published as a number in any original manual or
/// guide, only ever as coloured bars. So this is a playtest value, chosen as
/// roughly twice [`TIER_STRENGTH`]'s maximum so that stacking is worth doing and
/// still finite. Phase 8 settles it; nothing here cites it as sourced.
pub const MERGE_MAX_STRENGTH: u8 = 16;

/// Ceiling on a merged walker's hp, keeping the spawn invariant `hp = strength *
/// 16` (see `walkers::spawn`) true at the cap as well as below it.
pub const MERGE_MAX_HP: i16 = MERGE_MAX_STRENGTH as i16 * 16;

/// HANDOFF §4.5: `(face, x: Q16.16, y: Q16.16, strength, hp)`.
///
/// `id` is the slot index and never changes, which is what makes the §4.7
/// "sort by walker ID ascending" rule cheap: walkers are already stored in ID
/// order, so a counting sort over cells preserves it for free.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Walker {
    /// Q16.16 position within the face, in cells.
    pub x: i32,
    pub y: i32,
    pub hp: i16,
    pub id: u16,
    /// Settlement that spawned this walker, or [`NO_SETTLEMENT`].
    pub home: u16,
    pub face: u8,
    pub owner: u8,
    pub strength: u8,
    pub flags: u8,
}

impl Walker {
    #[inline]
    #[must_use]
    pub const fn alive(&self) -> bool {
        self.flags & WALKER_ALIVE != 0
    }
}

pub const SETTLE_ALIVE: u8 = 1 << 0;

/// HANDOFF §4.6. `size` is the plateau edge length (3, 5, 7 or 9); `tier` is the
/// index into [`TIER_STRENGTH`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Settlement {
    /// Build progress, in the same units as the tier thresholds.
    pub progress: i32,
    pub face: u8,
    pub x: u8,
    pub y: u8,
    pub size: u8,
    pub tier: u8,
    pub owner: u8,
    pub pop: u8,
    pub flags: u8,
}

impl Settlement {
    #[inline]
    #[must_use]
    pub const fn alive(&self) -> bool {
        self.flags & SETTLE_ALIVE != 0
    }
}

/// HANDOFF §4.6, all `[START]`. Index 0 is "no settlement".
pub const TIER_SIZE: [u8; 5] = [0, 3, 5, 7, 9];
pub const TIER_POP: [u8; 5] = [0, 2, 5, 10, 18];
pub const TIER_STRENGTH: [u8; 5] = [0, 1, 2, 4, 7];
/// Build progress needed to reach each tier.
pub const TIER_THRESHOLD: [i32; 5] = [0, 60, 200, 480, 900];

pub const PICKUP_ALIVE: u8 = 1 << 0;

/// A free single-use power lying on the terrain (§5.3).
///
/// A contested map object: it sits on ground nobody holds, and walkers do not
/// leave their own influence without a magnet (§4.5) — so collecting one costs
/// a deliberate magnet placement, which is the only command in the game. That
/// is what makes it excellent in a duel rather than a pickup that whoever
/// happens to be nearest gets for free.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pickup {
    pub face: u8,
    pub x: u8,
    pub y: u8,
    /// Index into [`MapConfig::power_enabled`].
    pub power: u8,
    pub flags: u8,
    pub _pad: [u8; 3],
}

impl Pickup {
    #[inline]
    #[must_use]
    pub const fn alive(&self) -> bool {
        self.flags & PICKUP_ALIVE != 0
    }
}

/// The papal magnet: the only command in the game (§5.1).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Magnet {
    pub face: u8,
    pub x: u8,
    pub y: u8,
    pub active: u8,
    /// Walker id of the current leader, or `u16::MAX`.
    pub leader: u16,
    pub _pad: u16,
}

// ---------------------------------------------------------------------------
// Commands (HANDOFF §6.2)
// ---------------------------------------------------------------------------

/// A single player input, already resolved to a verb and a target cell.
///
/// The simulation advances by `tick(commands: &[Command])` and nothing else.
/// Netcode is therefore a transport concern: it changes where this slice comes
/// from, never what the simulation does with it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Command {
    pub tick: u32,
    pub x: u16,
    pub y: u16,
    pub player: u8,
    pub verb: u8,
    pub face: u8,
    pub modifier: u8,
}

impl Command {
    /// Pack to the 8 wire bytes of §6.2.
    ///
    /// The spec lists seven fields totalling 12 bytes and then says "packed to
    /// 8 bytes", so a bit layout has to be chosen. This one spends 4 bits on the
    /// verb (11 exist), 2 on the player, 3 on the face, 6 on the modifier, 9
    /// each on x and y (so N may grow to 512), and gives the remaining 31 bits
    /// to the tick — 2.2 years at 30 Hz.
    #[must_use]
    pub const fn encode(&self) -> [u8; 8] {
        let v = (self.verb as u64 & 0xF)
            | ((self.player as u64 & 0x3) << 4)
            | ((self.face as u64 & 0x7) << 6)
            | ((self.modifier as u64 & 0x3F) << 9)
            | ((self.x as u64 & 0x1FF) << 15)
            | ((self.y as u64 & 0x1FF) << 24)
            | ((self.tick as u64 & 0x7FFF_FFFF) << 33);
        v.to_le_bytes()
    }

    #[must_use]
    pub const fn decode(b: [u8; 8]) -> Self {
        let v = u64::from_le_bytes(b);
        Self {
            verb: (v & 0xF) as u8,
            player: ((v >> 4) & 0x3) as u8,
            face: ((v >> 6) & 0x7) as u8,
            modifier: ((v >> 9) & 0x3F) as u8,
            x: ((v >> 15) & 0x1FF) as u16,
            y: ((v >> 24) & 0x1FF) as u16,
            tick: ((v >> 33) & 0x7FFF_FFFF) as u32,
        }
    }
}

/// Fixed-capacity command buffer. No allocation inside a tick (§9.4).
pub const MAX_COMMANDS_PER_TICK: usize = 64;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct CommandBuf {
    pub items: [Command; MAX_COMMANDS_PER_TICK],
    pub len: u32,
}

impl Default for CommandBuf {
    fn default() -> Self {
        Self::new()
    }
}

impl CommandBuf {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            items: [Command { tick: 0, x: 0, y: 0, player: 0, verb: 0, face: 0, modifier: 0 };
                MAX_COMMANDS_PER_TICK],
            len: 0,
        }
    }

    pub const fn clear(&mut self) {
        self.len = 0;
    }

    /// Push, silently dropping past capacity. Dropping is deterministic; growing
    /// would allocate inside a tick.
    pub const fn push(&mut self, c: Command) {
        if (self.len as usize) < MAX_COMMANDS_PER_TICK {
            self.items[self.len as usize] = c;
            self.len += 1;
        }
    }

    #[must_use]
    pub fn as_slice(&self) -> &[Command] {
        &self.items[..self.len as usize]
    }
}

// ---------------------------------------------------------------------------
// Map manifest (HANDOFF §5.4)
// ---------------------------------------------------------------------------

pub const TERRAIN_ARCHIPELAGO: u8 = 0;
pub const TERRAIN_PANGAEA: u8 = 1;
pub const TERRAIN_VOLCANO: u8 = 2;

/// The map is the ruleset, not just geometry (§5.4). Pure configuration, no
/// runtime state, therefore trivially deterministic.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MapConfig {
    pub n: u16,
    pub seed: u32,
    pub terrain: u8,
    pub waves: u8,
    pub telegraph_ticks: u32,
    pub impact_ticks: u32,
    pub recovery_ticks: u32,
    /// Percent per wave, integer (§5.4).
    pub escalation: u16,
    /// Height units the first wave adds to sea level.
    pub wave_strength: i16,
    pub power_enabled: [u8; POWER_COUNT],
    pub power_cost: [u16; POWER_COUNT],
    /// Scripted opponent (this run only; not part of the shipped ruleset).
    pub ai_enabled: u8,
    pub ai_player: u8,
}

impl Default for MapConfig {
    fn default() -> Self {
        Self::DEFAULT
    }
}

impl MapConfig {
    /// Matches the manifest printed in HANDOFF §5.4.
    pub const DEFAULT: Self = Self {
        n: N as u16,
        seed: 0x5EED,
        terrain: TERRAIN_ARCHIPELAGO,
        waves: 7,
        telegraph_ticks: 300,
        impact_ticks: 150,
        recovery_ticks: 900,
        escalation: 115,
        wave_strength: 48,
        power_enabled: [1, 1, 1, 0, 1, 1, 1, 1],
        power_cost: [0, 20, 120, 200, 260, 400, 700, 4000],
        ai_enabled: 0,
        ai_player: 1,
    };
}

// ---------------------------------------------------------------------------
// Tide (HANDOFF §5.5)
// ---------------------------------------------------------------------------

pub const TIDE_CALM: u8 = 0;
pub const TIDE_TELEGRAPH: u8 = 1;
pub const TIDE_IMPACT: u8 = 2;
pub const TIDE_RECOVERY: u8 = 3;
pub const TIDE_DONE: u8 = 4;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TideState {
    pub phase: u8,
    pub wave: u8,
    pub scored: u8,
    pub _pad: u8,
    pub timer: u32,
    /// Peak sea-level offset of the current wave, in height units.
    pub strength: i16,
    /// Sea-level offset applied right now. Negative during telegraph — the sea
    /// visibly draws back before it hits, which is the whole no-UI warning.
    pub offset: i16,
}

/// Scripted-opponent bookkeeping. See `ai.rs`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AiState {
    pub script_pc: u16,
    pub repeat: u16,
    pub timer: u32,
    pub cursor: u32,
    pub anchor_face: u8,
    pub anchor_x: u8,
    pub anchor_y: u8,
    pub _pad: u8,
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/// The entire simulation state.
///
/// Every field is a plain integer or an array of plain integers, with no
/// padding-sensitive types, no enums with niches and no pointers. That is not
/// incidental: it is what lets [`World::boxed`] hand back a zeroed allocation
/// without a stack copy, and what makes the state hash a straight walk over
/// memory.
#[repr(C)]
pub struct World {
    // --- hashed simulation state (§6.3) ---
    pub height: [i16; CELLS],
    pub water: [i16; CELLS],
    pub lava: [u8; CELLS],
    pub material: [u8; CELLS],
    pub influence: [i8; CELLS],
    pub fertility: [u8; CELLS],
    pub vegetation: [u8; CELLS],
    pub sediment: [u8; CELLS],
    /// Consecutive ticks with no water and no vegetation (§4.4, last rule).
    pub dry_ticks: [u16; CELLS],

    // --- derived per-tick scratch, not hashed ---
    /// Magnitude of the largest outgoing water flow last tick, saturated at 255.
    pub erode: [u8; CELLS],
    /// `max(water[c], water[neighbours])`, so the §4.4 lava rule stays a plain
    /// per-cell predicate instead of a neighbour query inside the rule engine.
    pub water_near: [i16; CELLS],
    /// Largest square of exactly equal height whose bottom-right corner is here.
    pub plateau: [u8; CELLS],
    /// Which settlement claims this cell, or [`NO_SETTLEMENT`].
    pub settle_of: [u16; CELLS],
    /// Per-player flow field: a direction index, or [`NO_FLOW`].
    pub flow: [[u8; CELLS]; PLAYERS],
    /// BFS distance to the nearest target, per player.
    ///
    /// Per-player rather than shared scratch: with one buffer the second
    /// player's rebuild silently overwrites the first's, and every consumer
    /// (including the renderer, and any test that checks the field descends)
    /// reads a field that belongs to the wrong god.
    pub dist: [[u16; CELLS]; PLAYERS],
    /// BFS queue scratch.
    pub queue: [u32; CELLS],
    /// Per-player influence accumulator before the zero-sum combine (§4.5).
    pub infl_acc: [[i16; CELLS]; PLAYERS],
    /// Counting-sort buckets for combat (§4.7).
    pub cell_count: [u16; CELLS],
    pub cell_start: [u32; CELLS],
    pub bucket: [u16; MAX_WALKERS],
    /// Matter crossing a seam this pass, indexed like the ghost tables.
    /// Transfers into a ghost cell are recorded here and scattered to the real
    /// destination afterwards, so nothing is lost at a face boundary.
    pub seam_flux: [i32; GHOST_ENTRIES],

    // --- entities ---
    pub walkers: [Walker; MAX_WALKERS],
    pub settlements: [Settlement; MAX_SETTLEMENTS],
    pub pickups: [Pickup; MAX_PICKUPS],

    // --- scalars ---
    pub cfg: MapConfig,
    pub tide: TideState,
    pub ai: AiState,
    pub magnet: [Magnet; PLAYERS],
    pub hand: [Hand; PLAYERS],
    /// Q16.16.
    pub mana: [i32; PLAYERS],
    /// Free single-use charges collected from pickups, per power.
    pub free_uses: [[u8; POWER_COUNT]; PLAYERS],
    pub walker_count: [u16; PLAYERS],
    pub settlement_count: u16,
    pub score: [[u16; MAX_WAVES]; PLAYERS],
    pub tick: u32,
    /// Baseline sea level, moved only by the flood power (§4.3).
    pub sea_base: i16,
    /// Effective sea level: baseline plus the tide offset.
    pub sea_level: i16,
    pub rng: Rng,
    pub last_hash: u64,
    /// 0 = running, 1 = player 0 won, 2 = player 1 won, 3 = draw.
    pub outcome: u8,
    pub _pad: [u8; 7],
}

impl World {
    /// A zeroed world. Not playable until [`World::init`] runs, but it is a
    /// valid `World`, which is what lets the wasm shell keep one in `.bss` and
    /// never call the allocator — and therefore never grow linear memory (§9.3).
    #[must_use]
    pub const fn zeroed() -> Self {
        // SAFETY-adjacent note: written out rather than `zeroed()` so the
        // compiler can put it straight in `.bss` in a const context.
        Self {
            height: [0; CELLS],
            water: [0; CELLS],
            lava: [0; CELLS],
            material: [0; CELLS],
            influence: [0; CELLS],
            fertility: [0; CELLS],
            vegetation: [0; CELLS],
            sediment: [0; CELLS],
            dry_ticks: [0; CELLS],
            erode: [0; CELLS],
            water_near: [0; CELLS],
            plateau: [0; CELLS],
            settle_of: [NO_SETTLEMENT; CELLS],
            flow: [[NO_FLOW; CELLS]; PLAYERS],
            dist: [[0; CELLS]; PLAYERS],
            queue: [0; CELLS],
            infl_acc: [[0; CELLS]; PLAYERS],
            cell_count: [0; CELLS],
            cell_start: [0; CELLS],
            bucket: [0; MAX_WALKERS],
            seam_flux: [0; GHOST_ENTRIES],
            walkers: [Walker {
                x: 0,
                y: 0,
                hp: 0,
                id: 0,
                home: NO_SETTLEMENT,
                face: 0,
                owner: 0,
                strength: 0,
                flags: 0,
            }; MAX_WALKERS],
            settlements: [Settlement {
                progress: 0,
                face: 0,
                x: 0,
                y: 0,
                size: 0,
                tier: 0,
                owner: 0,
                pop: 0,
                flags: 0,
            }; MAX_SETTLEMENTS],
            pickups: [Pickup { face: 0, x: 0, y: 0, power: 0, flags: 0, _pad: [0; 3] };
                MAX_PICKUPS],
            cfg: MapConfig::DEFAULT,
            tide: TideState {
                phase: 0,
                wave: 0,
                scored: 0,
                _pad: 0,
                timer: 0,
                strength: 0,
                offset: 0,
            },
            ai: AiState {
                script_pc: 0,
                repeat: 0,
                timer: 0,
                cursor: 0,
                anchor_face: 0,
                anchor_x: 0,
                anchor_y: 0,
                _pad: 0,
            },
            magnet: [Magnet { face: 0, x: 0, y: 0, active: 0, leader: u16::MAX, _pad: 0 }; PLAYERS],
            hand: [Hand { material: HAND_EARTH, _pad: 0, amount: 0 }; PLAYERS],
            mana: [0; PLAYERS],
            free_uses: [[0; POWER_COUNT]; PLAYERS],
            walker_count: [0; PLAYERS],
            settlement_count: 0,
            score: [[0; MAX_WAVES]; PLAYERS],
            tick: 0,
            sea_base: 0,
            sea_level: 0,
            rng: Rng { state: 0 },
            last_hash: 0,
            outcome: 0,
            _pad: [0; 7],
        }
    }

    /// Allocate a zeroed world on the heap.
    ///
    /// `World` is around a megabyte, so it must never be built on the stack.
    /// Requires the `alloc` feature; the wasm shell does not enable it.
    #[cfg(feature = "alloc")]
    #[must_use]
    #[allow(unsafe_code)]
    pub fn boxed() -> alloc::boxed::Box<Self> {
        use core::alloc::Layout;
        let layout = Layout::new::<Self>();
        // SAFETY: `World` is `#[repr(C)]` and contains only integer arrays and
        // `#[repr(C)]` structs of integers, so the all-zero bit pattern is a
        // valid value. The two fields that want a non-zero default
        // (`settle_of`, `flow`) are fixed up immediately below.
        let mut b = unsafe {
            let p = alloc::alloc::alloc_zeroed(layout).cast::<Self>();
            if p.is_null() {
                alloc::alloc::handle_alloc_error(layout);
            }
            alloc::boxed::Box::from_raw(p)
        };
        b.settle_of = [NO_SETTLEMENT; CELLS];
        b.flow = [[NO_FLOW; CELLS]; PLAYERS];
        b.cfg = MapConfig::DEFAULT;
        for m in &mut b.magnet {
            m.leader = u16::MAX;
        }
        for w in &mut b.walkers {
            w.home = NO_SETTLEMENT;
        }
        b
    }

    /// Reset to a freshly generated world for `cfg`.
    pub fn init(&mut self, cfg: &MapConfig) {
        *self = Self::zeroed();
        self.cfg = *cfg;
        self.rng = Rng::new(u64::from(cfg.seed));
        self.sea_base = 0;
        self.sea_level = 0;
        self.generate_terrain();
        self.ghost_copy_all();
        settlements::detect_plateaus(self);
        settlements::seed_starting_positions(self);
        flowfield::project(self);
        flowfield::rebuild(self);
    }

    // -----------------------------------------------------------------------
    // Ghost borders (HANDOFF §3.4)
    // -----------------------------------------------------------------------

    /// Copy the boundary rows and columns of neighbouring faces into each face's
    /// ghost border. 24 copy operations, flattened into one gather.
    ///
    /// Every CA pass then iterates a plain borderless 2D grid with zero seam
    /// checks in the hot loop, which is the entire point of the ghost ring.
    pub fn ghost_copy_all(&mut self) {
        for k in 0..GHOST_ENTRIES {
            let d = GHOST_DST[k] as usize;
            let s = GHOST_SRC[k] as usize;
            self.height[d] = self.height[s];
            self.water[d] = self.water[s];
            self.lava[d] = self.lava[s];
            self.material[d] = self.material[s];
            self.vegetation[d] = self.vegetation[s];
            self.fertility[d] = self.fertility[s];
            self.sediment[d] = self.sediment[s];
            self.influence[d] = self.influence[s];
        }
    }

    /// The subset the flow passes need between their two checkerboard halves.
    /// Refreshing here is what keeps matter conserved across a seam: both sides
    /// of a boundary pair compute the same transfer from the same inputs.
    pub fn ghost_copy_flow_fields(&mut self) {
        for k in 0..GHOST_ENTRIES {
            let d = GHOST_DST[k] as usize;
            let s = GHOST_SRC[k] as usize;
            self.height[d] = self.height[s];
            self.water[d] = self.water[s];
            self.lava[d] = self.lava[s];
            self.vegetation[d] = self.vegetation[s];
        }
    }

    /// Scatter accumulated seam flux back onto the real destination cells.
    ///
    /// A flow pass writing into a ghost cell would lose that matter, because
    /// ghosts are overwritten on the next copy. Instead each such transfer is
    /// recorded against the seam entry it crossed and applied here.
    pub fn apply_seam_flux_i16(&mut self, field: FluxField) {
        for k in 0..GHOST_ENTRIES {
            let f = self.seam_flux[k];
            if f == 0 {
                continue;
            }
            self.seam_flux[k] = 0;
            let dst = GHOST_SRC[k] as usize;
            match field {
                FluxField::Water => {
                    self.water[dst] =
                        (i32::from(self.water[dst]) + f).clamp(0, i32::from(i16::MAX)) as i16;
                }
                FluxField::Lava => {
                    self.lava[dst] = (i32::from(self.lava[dst]) + f).clamp(0, 255) as u8;
                }
                FluxField::Height => {
                    self.height[dst] = (i32::from(self.height[dst]) + f)
                        .clamp(i32::from(HEIGHT_MIN), i32::from(HEIGHT_MAX))
                        as i16;
                }
            }
        }
    }

    /// Ghost slot index -> seam entry index, or `None` for a live cell.
    ///
    /// The ghost ring is contiguous per face, so this is a small amount of
    /// arithmetic rather than a lookup table over all cells.
    #[inline]
    #[must_use]
    pub fn seam_entry_of_ghost(ghost: usize) -> Option<usize> {
        let face = ghost / FACE_CELLS;
        if face >= 6 {
            return None;
        }
        let within = ghost % FACE_CELLS;
        let row = within / S;
        let col = within % S;
        // Live coordinates are 1..=N in storage space.
        let (edge, t) = if row == 0 && (1..=N).contains(&col) {
            (crate::seams::DIR_S, col - 1)
        } else if row == S - 1 && (1..=N).contains(&col) {
            (crate::seams::DIR_N, col - 1)
        } else if col == 0 && (1..=N).contains(&row) {
            (crate::seams::DIR_W, row - 1)
        } else if col == S - 1 && (1..=N).contains(&row) {
            (crate::seams::DIR_E, row - 1)
        } else {
            return None;
        };
        Some((face * 4 + edge) * N + t)
    }

    // -----------------------------------------------------------------------
    // Terrain generation
    // -----------------------------------------------------------------------

    /// Seamless procedural terrain.
    ///
    /// The noise is sampled at the cell's position **on the cube**, in 3D. That
    /// is why there is no seam in the generated terrain: adjacent cells across a
    /// face boundary are adjacent in 3D too, so no per-face fixup is needed.
    fn generate_terrain(&mut self) {
        let seed = self.cfg.seed;
        let amp: i32 = 720;
        let bias: i32 = match self.cfg.terrain {
            TERRAIN_PANGAEA => -40,
            TERRAIN_VOLCANO => 60,
            _ => 150, // archipelago: most of the surface starts under water
        };

        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let (px, py, pz) = cube_point(face, x as i32, y as i32);
                    let h = fbm(px, py, pz, seed);
                    let centred = h - 32768;
                    let height = (centred * amp / 32768) - bias;
                    let c = idx(face, x, y);
                    self.height[c] =
                        height.clamp(i32::from(HEIGHT_MIN), i32::from(HEIGHT_MAX)) as i16;

                    let f = fbm(px + 8192, py - 4096, pz + 2048, seed ^ 0x9E37) >> 8; // 0..255
                    self.fertility[c] = f as u8;

                    self.material[c] = if height > 380 {
                        MAT_ROCK
                    } else if height > -30 {
                        if f > 140 { MAT_SOIL } else { MAT_SAND }
                    } else {
                        MAT_SAND
                    };
                }
            }
        }

        // Fill everything below sea level (§4.3).
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    let depth = i32::from(self.sea_level) - i32::from(self.height[c]);
                    self.water[c] = depth.max(0).min(i32::from(i16::MAX)) as i16;
                }
            }
        }

        if self.cfg.terrain == TERRAIN_VOLCANO {
            // One crater at the centre of face 4, so the map has the contested
            // generative resource of §4.4 from tick zero.
            let c = idx(4, N / 2, N / 2);
            self.height[c] = self.height[c].saturating_add(200);
            self.lava[c] = 200;
            self.water[c] = 0;
        }
    }

    // -----------------------------------------------------------------------
    // Terrain deformation (HANDOFF §4.2)
    // -----------------------------------------------------------------------

    /// Brush radius for a modifier: poured is small and under the hand, thrown
    /// is large at the impact point (§5.3).
    #[must_use]
    pub const fn brush_radius(modifier: u8) -> i32 {
        let base = if modifier & MOD_THROWN != 0 { 2 } else { 1 };
        if modifier & MOD_EXTREME != 0 {
            base + 3
        } else if modifier & MOD_INCREASED != 0 {
            base + 1
        } else {
            base
        }
    }

    /// Raise or lower terrain within a brush footprint, conserving matter.
    ///
    /// Pillar 4: what the player removes must go somewhere. Lowering fills the
    /// hand; raising empties it. **A full hand cannot dig and an empty hand
    /// cannot build**, which is the anti-griefing rule stated as a mechanic
    /// rather than as a cost.
    ///
    /// Returns the number of height units actually moved.
    pub fn deform(
        &mut self,
        player: usize,
        face: usize,
        cx: i32,
        cy: i32,
        radius: i32,
        raise: bool,
    ) -> i32 {
        if self.hand[player].material != HAND_EARTH {
            return 0;
        }
        let mut moved = 0i32;
        // Fixed traversal order (row-major within the brush) so the order in
        // which the hand fills or empties is not a function of anything else.
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                if dx * dx + dy * dy > radius * radius + radius {
                    continue;
                }
                let Some((f, x, y)) = walk(face, cx, cy, dx, dy) else { continue };
                let c = idx(f, x, y);
                if raise {
                    let room = i32::from(HEIGHT_MAX) - i32::from(self.height[c]);
                    let take =
                        i32::from(TERRACE).min(room).min(i32::from(self.hand[player].amount));
                    if take <= 0 {
                        continue;
                    }
                    self.height[c] = self.height[c].saturating_add(take as i16);
                    self.hand[player].amount -= take as u16;
                    moved += take;
                } else {
                    let room = i32::from(HAND_CAPACITY) - i32::from(self.hand[player].amount);
                    let avail = i32::from(self.height[c]) - i32::from(HEIGHT_MIN);
                    let take = i32::from(TERRACE).min(room).min(avail);
                    if take <= 0 {
                        continue;
                    }
                    self.height[c] = self.height[c].saturating_sub(take as i16);
                    self.hand[player].amount += take as u16;
                    moved += take;
                }
                self.refresh_cell_water(c);
            }
        }
        moved
    }

    /// Re-settle a cell against the current sea level after its height moved.
    fn refresh_cell_water(&mut self, c: usize) {
        let surface = i32::from(self.height[c]) + i32::from(self.water[c]);
        let sea = i32::from(self.sea_level);
        if surface < sea {
            self.water[c] = (sea - i32::from(self.height[c])).clamp(0, i32::from(i16::MAX)) as i16;
        } else if self.water[c] > 0 && i32::from(self.height[c]) > sea {
            // Terrain rose out from under standing water; keep the depth but do
            // not let it exceed what the cell can hold above sea level.
            let keep = i32::from(self.water[c]);
            self.water[c] = keep.clamp(0, i32::from(i16::MAX)) as i16;
        }
    }

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    /// Above the waterline, not molten, not swamp: somewhere a walker can stand.
    #[inline]
    #[must_use]
    pub fn passable(&self, c: usize) -> bool {
        self.lava[c] == 0
            && self.material[c] != MAT_SWAMP
            && i32::from(self.height[c]) > i32::from(self.sea_level)
            && i32::from(self.water[c]) < i32::from(TERRACE)
    }

    /// Contributes to mana (§4.6): above sea level, soil or rock.
    #[inline]
    #[must_use]
    pub fn habitable(&self, c: usize) -> bool {
        i32::from(self.height[c]) > i32::from(self.sea_level)
            && (self.material[c] == MAT_SOIL || self.material[c] == MAT_ROCK)
            && self.water[c] == 0
    }

    /// Mana in whole units, for cost checks.
    #[inline]
    #[must_use]
    pub const fn mana_units(&self, player: usize) -> i32 {
        self.mana[player] >> 16
    }

    #[inline]
    pub const fn spend_mana(&mut self, player: usize, units: i32) -> bool {
        if self.mana_units(player) < units {
            return false;
        }
        self.mana[player] -= units << 16;
        true
    }

    // -----------------------------------------------------------------------
    // State hash (HANDOFF §6.3)
    // -----------------------------------------------------------------------

    /// Hash `height`, `water`, `lava`, `material`, `influence` plus walker and
    /// settlement state.
    ///
    /// Only live cells are hashed. Ghost cells are a derived cache and hashing
    /// them would let a harmless copy-order difference read as a desync.
    #[must_use]
    pub fn state_hash(&self) -> u64 {
        let mut h = Fnv64::new();
        h.write_u32(self.tick);
        h.write_i16(self.sea_level);
        h.write_i16(self.sea_base);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    h.write_i16(self.height[c]);
                    h.write_i16(self.water[c]);
                    h.write_u8(self.lava[c]);
                    h.write_u8(self.material[c]);
                    h.write_i8(self.influence[c]);
                    h.write_u8(self.vegetation[c]);
                    h.write_u8(self.fertility[c]);
                    h.write_u8(self.sediment[c]);
                }
            }
        }
        for w in &self.walkers {
            if !w.alive() {
                // Dead slots still take part, as a fixed marker, so that slot
                // reuse cannot be confused with slot survival.
                h.write_u8(0);
                continue;
            }
            h.write_u8(1);
            h.write_i32(w.x);
            h.write_i32(w.y);
            h.write_i16(w.hp);
            h.write_u16(w.id);
            h.write_u16(w.home);
            h.write_u8(w.face);
            h.write_u8(w.owner);
            h.write_u8(w.strength);
            h.write_u8(w.flags);
        }
        for s in &self.settlements {
            h.write_u8(s.flags);
            if !s.alive() {
                continue;
            }
            h.write_i32(s.progress);
            h.write_u8(s.face);
            h.write_u8(s.x);
            h.write_u8(s.y);
            h.write_u8(s.size);
            h.write_u8(s.tier);
            h.write_u8(s.owner);
            h.write_u8(s.pop);
        }
        for p in &self.pickups {
            h.write_u8(p.flags);
            if !p.alive() {
                continue;
            }
            h.write_u8(p.face);
            h.write_u8(p.x);
            h.write_u8(p.y);
            h.write_u8(p.power);
        }
        for p in 0..PLAYERS {
            h.write_i32(self.mana[p]);
            for &n in &self.free_uses[p] {
                h.write_u8(n);
            }
            h.write_u16(self.walker_count[p]);
            h.write_u8(self.hand[p].material);
            h.write_u16(self.hand[p].amount);
            h.write_u8(self.magnet[p].active);
            h.write_u8(self.magnet[p].face);
            h.write_u8(self.magnet[p].x);
            h.write_u8(self.magnet[p].y);
            h.write_u16(self.magnet[p].leader);
        }
        h.write_u8(self.tide.phase);
        h.write_u8(self.tide.wave);
        h.write_u32(self.tide.timer);
        h.write_i16(self.tide.offset);
        h.write_i16(self.tide.strength);
        h.write_u8(self.outcome);
        h.write_u64(self.rng.state);
        h.finish()
    }

    // -----------------------------------------------------------------------
    // Tick (HANDOFF §4.1)
    // -----------------------------------------------------------------------

    /// Advance one 30 Hz tick.
    ///
    /// The pass order below is fixed and load-bearing for determinism (§4.1).
    /// Two passes are not in the spec's list and are marked as such: the tide,
    /// which must move sea level before water transfers reads it, and the
    /// scripted opponent, which emits ordinary commands and is therefore applied
    /// through exactly the same path as player input.
    pub fn tick(&mut self, commands: &[Command]) {
        // 1. ghost border copy
        self.ghost_copy_all();

        // 2. command application
        self.apply_commands(commands);

        // 2a. tide (§5.5) — before water, because it moves the sea level.
        tide::step(self);

        // 2b. scripted opponent — emits commands, applies them like any others.
        if self.cfg.ai_enabled != 0 {
            let mut buf = CommandBuf::new();
            ai::step(self, &mut buf);
            self.apply_commands(buf.as_slice());
        }

        // 3. water transfer (checkerboard: even, then odd)
        water::transfer_water(self);
        // 4. lava transfer (checkerboard: even, then odd)
        water::transfer_lava(self);
        // 5. material interactions (single pass, §4.4)
        materials::interactions(self);
        // 6. granular movement (checkerboard: even, then odd)
        materials::granular(self);
        // 7. vegetation growth (single pass)
        materials::vegetation(self);
        // 8. walkers: movement (fixed walker-id order)
        walkers::movement(self);
        // 8a. one-shot pickups: spawn and collect (§5.3). Immediately after
        // movement, because it is a query over walker positions and running it
        // before combat means a walker that dies this tick still collected what
        // it stood on.
        powers::pickups_step(self);
        // 9. walkers: combat resolution (§4.7)
        combat::resolve(self);
        // 10. settlements: build / decay
        settlements::update(self);
        // 11. every 15 ticks: flow field + influence projection (§4.5)
        if self.tick.is_multiple_of(15) {
            flowfield::rebuild(self);
            flowfield::project(self);
        }
        // 12. mana accrual
        self.accrue_mana();
        // 13. every 30 ticks: state hash
        if self.tick.is_multiple_of(30) {
            self.last_hash = self.state_hash();
        }

        self.tick = self.tick.wrapping_add(1);
    }

    /// Apply a slice of commands. Public so the perf harness can drive passes
    /// individually without reimplementing any of them.
    pub fn apply_commands(&mut self, commands: &[Command]) {
        for cmd in commands {
            if cmd.verb == VERB_NOP || cmd.verb >= VERB_COUNT {
                continue;
            }
            let player = (cmd.player as usize) % PLAYERS;
            powers::apply(self, player, cmd);
        }
    }

    /// HANDOFF §4.6: mana from held habitable territory, not from population.
    pub fn accrue_mana(&mut self) {
        const MANA_DIVISOR: i32 = 256;
        let mut acc = [0i32; PLAYERS];
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    if !self.habitable(c) {
                        continue;
                    }
                    let infl = i32::from(self.influence[c]);
                    if infl > 0 {
                        acc[0] += 1;
                    } else if infl < 0 {
                        acc[1] += 1;
                    }
                }
            }
        }
        // Settlement tier acts as a multiplier on the cells within its reach,
        // not as the base (§4.6).
        let mut mult = [16i32; PLAYERS];
        for s in &self.settlements {
            if s.alive() {
                mult[(s.owner as usize) % PLAYERS] += i32::from(TIER_STRENGTH[s.tier as usize]);
            }
        }
        for p in 0..PLAYERS {
            // Q16.16 accumulator: fractional mana per tick is the norm, and
            // truncating it every tick would make small holdings pay nothing.
            let per_tick = (acc[p] * mult[p]) << 16;
            self.mana[p] = self.mana[p].saturating_add(per_tick / (MANA_DIVISOR * 16));
            self.mana[p] = self.mana[p].min(9_999 << 16);
        }
    }
}

/// Which field a pending seam flux belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FluxField {
    Water,
    Lava,
    Height,
}

/// Walk `(dx, dy)` cells from `(face, cx, cy)`, following seams.
///
/// Steps one axis then the other, which is well defined because each step goes
/// through [`step`] and carries the rotated heading with it. Returns `None`
/// only if the start cell is off-grid.
#[must_use]
pub fn walk(face: usize, cx: i32, cy: i32, dx: i32, dy: i32) -> Option<(usize, usize, usize)> {
    if !(0..N as i32).contains(&cx) || !(0..N as i32).contains(&cy) || face >= 6 {
        return None;
    }
    let (mut f, mut x, mut y) = (face, cx, cy);
    let mut d = if dx >= 0 { crate::seams::DIR_E } else { crate::seams::DIR_W };
    for _ in 0..dx.abs() {
        let n = step(f, x, y, d);
        f = n.0;
        x = n.1;
        y = n.2;
        d = n.3;
    }
    let mut d = if dy >= 0 { crate::seams::DIR_N } else { crate::seams::DIR_S };
    for _ in 0..dy.abs() {
        let n = step(f, x, y, d);
        f = n.0;
        x = n.1;
        y = n.2;
        d = n.3;
    }
    Some((f, x as usize, y as usize))
}

// ---------------------------------------------------------------------------
// Integer value noise
// ---------------------------------------------------------------------------

/// Cube half-extent in noise units. Cells map into `[-CUBE, CUBE]` on each axis.
const CUBE: i32 = 4096;

/// The cell's position on the *cube*, in integer noise units.
#[must_use]
pub const fn cube_point(face: usize, x: i32, y: i32) -> (i32, i32, i32) {
    // (2x + 1 - N) / N, scaled to +/-CUBE. Cell centres, so no cell sits exactly
    // on a face boundary and adjacent cells across a seam land one step apart.
    let a = (2 * x + 1 - N as i32) * CUBE / N as i32;
    let b = (2 * y + 1 - N as i32) * CUBE / N as i32;
    let n = FACE_NORMAL3[face];
    let r = FACE_RIGHT3[face];
    let u = FACE_UP3[face];
    (
        n[0] * CUBE + r[0] * a + u[0] * b,
        n[1] * CUBE + r[1] * a + u[1] * b,
        n[2] * CUBE + r[2] * a + u[2] * b,
    )
}

const FACE_NORMAL3: [[i32; 3]; 6] =
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACE_RIGHT3: [[i32; 3]; 6] =
    [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
const FACE_UP3: [[i32; 3]; 6] = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];

/// Smoothstep in Q16, `t` in `0..=65536`.
///
/// The 64-bit intermediates are not decoration: `t * t` at `t = 65536` is
/// exactly `2^32`, which overflows `i32` — and with `overflow-checks` on in
/// every profile that is a panic, not a silent wrap.
const fn smooth(t: i32) -> i32 {
    let t = if t > 65536 {
        65536
    } else if t < 0 {
        0
    } else {
        t
    };
    let t2 = ((t as i64 * t as i64) >> 16) as i32;
    let a = 3 * 65536 - 2 * t;
    ((t2 as i64 * a as i64) >> 16) as i32
}

const fn lerp16(a: i32, b: i32, t: i32) -> i32 {
    a + (((b - a) as i64 * t as i64) >> 16) as i32
}

/// Integer 3D value noise. Returns `0..=65535`.
///
/// `shift` is the log2 of the lattice spacing. Arithmetic shift gives floor
/// division for negative coordinates, and masking gives the non-negative
/// remainder, so the lattice is continuous through the origin.
fn value_noise(px: i32, py: i32, pz: i32, shift: u32, seed: u32) -> i32 {
    let xi = px >> shift;
    let yi = py >> shift;
    let zi = pz >> shift;
    let mask = (1i32 << shift) - 1;
    let fx = smooth(((px & mask) << 16) >> shift);
    let fy = smooth(((py & mask) << 16) >> shift);
    let fz = smooth(((pz & mask) << 16) >> shift);

    let corner = |dx: i32, dy: i32, dz: i32| -> i32 {
        (hash3(xi + dx, yi + dy, zi + dz, seed) >> 16) as i32
    };

    let c00 = lerp16(corner(0, 0, 0), corner(1, 0, 0), fx);
    let c10 = lerp16(corner(0, 1, 0), corner(1, 1, 0), fx);
    let c01 = lerp16(corner(0, 0, 1), corner(1, 0, 1), fx);
    let c11 = lerp16(corner(0, 1, 1), corner(1, 1, 1), fx);
    let c0 = lerp16(c00, c10, fy);
    let c1 = lerp16(c01, c11, fy);
    lerp16(c0, c1, fz)
}

/// Four octaves of value noise. Returns `0..=65535`.
fn fbm(px: i32, py: i32, pz: i32, seed: u32) -> i32 {
    let a = value_noise(px, py, pz, 12, seed);
    let b = value_noise(px, py, pz, 11, seed ^ 0x1111);
    let c = value_noise(px, py, pz, 10, seed ^ 0x2222);
    let d = value_noise(px, py, pz, 9, seed ^ 0x3333);
    (a * 8 + b * 4 + c * 2 + d) / 15
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_formula_matches_the_spec() {
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    assert_eq!(idx(face, x, y), (face * S + (y + 1)) * S + (x + 1));
                    assert_eq!(idx(face, x, y), idx_i(face, x as i32, y as i32));
                }
            }
        }
        assert_eq!(CELLS, 6 * S * S);
        assert_eq!(LIVE_CELLS, 6 * N * N);
    }

    #[test]
    fn neighbour_flat_agrees_with_idx_inside_a_face() {
        for face in 0..6usize {
            for y in 1..N - 1 {
                for x in 1..N - 1 {
                    let c = idx(face, x, y);
                    assert_eq!(neighbour_flat(c, crate::seams::DIR_N), idx(face, x, y + 1));
                    assert_eq!(neighbour_flat(c, crate::seams::DIR_E), idx(face, x + 1, y));
                    assert_eq!(neighbour_flat(c, crate::seams::DIR_S), idx(face, x, y - 1));
                    assert_eq!(neighbour_flat(c, crate::seams::DIR_W), idx(face, x - 1, y));
                }
            }
        }
    }

    #[test]
    fn seam_entry_of_ghost_inverts_the_ghost_table() {
        for k in 0..GHOST_ENTRIES {
            assert_eq!(World::seam_entry_of_ghost(GHOST_DST[k] as usize), Some(k));
        }
        // Live cells and the four unused corner ghosts map to nothing.
        assert_eq!(World::seam_entry_of_ghost(idx(0, 5, 5)), None);
        assert_eq!(World::seam_entry_of_ghost(0), None);
    }

    #[test]
    fn ghost_copy_makes_edge_neighbours_readable_without_a_seam_check() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        for face in 0..6usize {
            for t in 0..N {
                for dir in 0..4usize {
                    let (lx, ly) = match dir {
                        crate::seams::DIR_N => (t, N - 1),
                        crate::seams::DIR_E => (N - 1, t),
                        crate::seams::DIR_S => (t, 0),
                        _ => (0, t),
                    };
                    let c = idx(face, lx, ly);
                    let ghost = neighbour_flat(c, dir);
                    let (sf, sx, sy, _) = step(face, lx as i32, ly as i32, dir);
                    let real = idx(sf, sx as usize, sy as usize);
                    assert_eq!(w.height[ghost], w.height[real]);
                    assert_eq!(w.material[ghost], w.material[real]);
                }
            }
        }
    }

    #[test]
    fn command_wire_format_roundtrips_in_eight_bytes() {
        let c = Command {
            tick: 1_234_567,
            x: 63,
            y: 17,
            player: 1,
            verb: VERB_VOLCANO,
            face: 5,
            modifier: MOD_THROWN | MOD_EXTREME,
        };
        let bytes = c.encode();
        assert_eq!(bytes.len(), 8);
        assert_eq!(Command::decode(bytes), c);
    }

    #[test]
    fn terrain_is_continuous_across_every_seam() {
        // The generator samples 3D cube positions, so a face boundary must not
        // be visible as a height discontinuity. Compare the step across each
        // seam against the typical step inside a face.
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);

        let mut inner_total: i64 = 0;
        let mut inner_n: i64 = 0;
        for face in 0..6usize {
            for y in 1..N - 1 {
                for x in 1..N - 1 {
                    let a = w.height[idx(face, x, y)];
                    let b = w.height[idx(face, x + 1, y)];
                    inner_total += i64::from((a - b).abs());
                    inner_n += 1;
                }
            }
        }
        let inner_mean = inner_total / inner_n;

        let mut seam_max = 0i32;
        let mut seam_total: i64 = 0;
        let mut seam_n: i64 = 0;
        for face in 0..6usize {
            for t in 0..N {
                for dir in 0..4usize {
                    let (lx, ly) = match dir {
                        crate::seams::DIR_N => (t as i32, N as i32 - 1),
                        crate::seams::DIR_E => (N as i32 - 1, t as i32),
                        crate::seams::DIR_S => (t as i32, 0),
                        _ => (0, t as i32),
                    };
                    let (sf, sx, sy, _) = step(face, lx, ly, dir);
                    let a = w.height[idx_i(face, lx, ly)];
                    let b = w.height[idx_i(sf, sx, sy)];
                    let d = i32::from((a - b).abs());
                    seam_max = seam_max.max(d);
                    seam_total += i64::from(d);
                    seam_n += 1;
                }
            }
        }
        let seam_mean = seam_total / seam_n;
        assert!(
            seam_mean <= inner_mean * 3,
            "terrain steps across seams (mean {seam_mean}, max {seam_max}) far exceed \
             the in-face mean {inner_mean}: the generator is not seamless"
        );
    }

    #[test]
    fn lowering_fills_the_hand_and_raising_empties_it() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        w.hand[0] = Hand { material: HAND_EARTH, _pad: 0, amount: 0 };

        let before: i64 = (0..6)
            .flat_map(|f| (0..N).flat_map(move |y| (0..N).map(move |x| (f, x, y))))
            .map(|(f, x, y)| i64::from(w.height[idx(f, x, y)]))
            .sum();

        let moved = w.deform(0, 0, 32, 32, 2, false);
        assert!(moved > 0, "lowering moved nothing");
        assert_eq!(i32::from(w.hand[0].amount), moved, "matter did not land in the hand");

        let after: i64 = (0..6)
            .flat_map(|f| (0..N).flat_map(move |y| (0..N).map(move |x| (f, x, y))))
            .map(|(f, x, y)| i64::from(w.height[idx(f, x, y)]))
            .sum();
        assert_eq!(before - after, i64::from(moved), "matter was not conserved");

        let raised = w.deform(0, 0, 32, 32, 2, true);
        assert_eq!(raised, moved, "the hand did not give back what it took");
        assert_eq!(w.hand[0].amount, 0);
    }

    #[test]
    fn an_empty_hand_cannot_build_and_a_full_hand_cannot_dig() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        w.hand[0].amount = 0;
        assert_eq!(w.deform(0, 0, 10, 10, 1, true), 0, "built something out of nothing");
        w.hand[0].amount = HAND_CAPACITY;
        assert_eq!(w.deform(0, 0, 10, 10, 1, false), 0, "dug with a full hand");
    }

    #[test]
    fn state_hash_reacts_to_every_hashed_field() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let base = w.state_hash();
        let c = idx(2, 10, 10);

        w.height[c] = w.height[c].wrapping_add(1);
        assert_ne!(w.state_hash(), base);
        w.height[c] = w.height[c].wrapping_sub(1);
        assert_eq!(w.state_hash(), base);

        w.influence[c] = w.influence[c].wrapping_add(1);
        assert_ne!(w.state_hash(), base);
        w.influence[c] = w.influence[c].wrapping_sub(1);

        w.lava[c] = 7;
        assert_ne!(w.state_hash(), base);
    }

    #[test]
    fn ghost_cells_are_not_hashed() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let base = w.state_hash();
        // Scribble on a ghost slot. It is a derived cache; the hash must ignore
        // it, or an innocuous copy-order difference would read as a desync.
        w.height[idx_i(0, -1, 5)] = 12_345;
        assert_eq!(w.state_hash(), base);
    }
}
