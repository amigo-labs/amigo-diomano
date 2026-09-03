//! The WebAssembly shell. HANDOFF §9.3, §9.4.
//!
//! This crate is deliberately almost empty. It contains no game logic, no
//! decisions and no state of its own beyond the two static buffers below. Every
//! export is either "advance one tick" or "here is a pointer".
//!
//! # No `wasm-bindgen`, no glue JS, no serialisation
//!
//! The interface is a handful of functions plus a memory pointer, so
//! `wasm-bindgen` would add a build step, a dependency and a generated
//! JavaScript file to wrap something that is already an ABI. `#[no_mangle] pub
//! extern "C"` plus `WebAssembly.instantiateStreaming` is the whole loader.
//!
//! # Zero copy, and memory that never grows
//!
//! Rust owns all state in linear memory; TypeScript holds `Int16Array` /
//! `Uint8Array` / `Float32Array` views over `memory.buffer` obtained from the
//! pointer getters here. Nothing is serialised across the boundary, ever, and
//! there is exactly one `tick()` call per tick — never one call per entity.
//!
//! Growing wasm memory detaches every view, so this crate must never allocate:
//! `diomano-sim` is built without its `alloc` feature, both big buffers live in
//! `.bss`, and no global allocator is linked. The module's declared initial
//! memory therefore covers everything it will ever use.

#![cfg_attr(target_arch = "wasm32", no_std)]
#![allow(clippy::missing_safety_doc)]

use diomano_sim::mesh::{self, Mesh};
use diomano_sim::world::{
    Command, CommandBuf, MapConfig, PLAYERS, Pickup, Settlement, Walker, World,
};
use diomano_sim::{powers, tide};

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // A panic here means a determinism invariant broke. There is nothing useful
    // to do in the browser except stop hard, loudly, at the exact instruction.
    core::arch::wasm32::unreachable()
}

/// A single-threaded global.
///
/// `static mut` would say the same thing but is a hard error to reference in
/// edition 2024. This wrapper is the sanctioned spelling: the `UnsafeCell` makes
/// the interior mutation explicit, and the `Sync` impl is where the
/// single-threaded assumption is written down rather than assumed.
#[repr(transparent)]
struct Global<T>(core::cell::UnsafeCell<T>);

// SAFETY: wasm32-unknown-unknown without the atomics proposal is single
// threaded, and every entry point in this file is called from the one game loop.
// If this module ever gains a worker, this impl is the thing that must go.
unsafe impl<T> Sync for Global<T> {}

impl<T> Global<T> {
    const fn new(v: T) -> Self {
        Self(core::cell::UnsafeCell::new(v))
    }

    #[allow(clippy::mut_from_ref)]
    fn get(&'static self) -> &'static mut T {
        // SAFETY: see the `Sync` impl. No two references are alive at once
        // because every caller below is a leaf `extern "C"` entry point.
        unsafe { &mut *self.0.get() }
    }
}

// The big buffers. Statics rather than `Box` because there is no allocator: see
// the module docs.
static WORLD: Global<World> = Global::new(World::zeroed());
static MESH: Global<Mesh> = Global::new(Mesh::zeroed());
static COMMANDS: Global<CommandBuf> = Global::new(CommandBuf::new());

fn world() -> &'static mut World {
    WORLD.get()
}

fn mesh_buf() -> &'static mut Mesh {
    MESH.get()
}

fn commands() -> &'static mut CommandBuf {
    COMMANDS.get()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Create a world. `terrain`: 0 archipelago, 1 pangaea, 2 volcano.
#[unsafe(no_mangle)]
pub extern "C" fn dio_init(seed: u32, terrain: u32, ai_enabled: u32) {
    let mut cfg = MapConfig::DEFAULT;
    cfg.seed = seed;
    cfg.terrain = (terrain & 0xFF) as u8;
    cfg.ai_enabled = u8::from(ai_enabled != 0);
    world().init(&cfg);
    commands().clear();
    let m = mesh_buf();
    m.build_tables();
    m.rebuild_all(world());
}

/// Queue a command for the next [`dio_tick`].
///
/// Commands are buffered rather than applied, because §4.1 puts command
/// application at a specific point in the tick and applying on arrival would
/// couple the result to input timing.
#[unsafe(no_mangle)]
pub extern "C" fn dio_push_command(
    player: u32,
    verb: u32,
    face: u32,
    x: u32,
    y: u32,
    modifier: u32,
) {
    let w = world();
    commands().push(Command {
        tick: w.tick,
        x: (x & 0xFFFF) as u16,
        y: (y & 0xFFFF) as u16,
        player: (player & 0xFF) as u8,
        verb: (verb & 0xFF) as u8,
        face: (face & 0xFF) as u8,
        modifier: (modifier & 0xFF) as u8,
    });
}

/// Advance one 30 Hz tick. One call per tick, never one per entity.
#[unsafe(no_mangle)]
pub extern "C" fn dio_tick() {
    let buf = *commands();
    world().tick(buf.as_slice());
    commands().clear();
}

/// Re-mesh dirty chunks. Returns how many were rebuilt.
#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_update() -> u32 {
    let w: &World = world();
    mesh_buf().update(w)
}

// ---------------------------------------------------------------------------
// Field pointers (HANDOFF §9.3)
// ---------------------------------------------------------------------------

macro_rules! field_ptr {
    ($name:ident, $field:ident, $ty:ty) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> *const $ty {
            world().$field.as_ptr()
        }
    };
}

field_ptr!(dio_height_ptr, height, i16);
field_ptr!(dio_water_ptr, water, i16);
field_ptr!(dio_lava_ptr, lava, u8);
field_ptr!(dio_material_ptr, material, u8);
field_ptr!(dio_fertility_ptr, fertility, u8);
field_ptr!(dio_vegetation_ptr, vegetation, u8);
field_ptr!(dio_sediment_ptr, sediment, u8);
field_ptr!(dio_influence_ptr, influence, i8);
field_ptr!(dio_erode_ptr, erode, u8);

#[unsafe(no_mangle)]
pub extern "C" fn dio_walkers_ptr() -> *const Walker {
    world().walkers.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_settlements_ptr() -> *const Settlement {
    world().settlements.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_pickups_ptr() -> *const Pickup {
    world().pickups.as_ptr()
}

/// Ring of applied verbs, for the renderer's effects. Instrumentation, not state:
/// excluded from the state hash, so nothing read here can desync a match.
#[unsafe(no_mangle)]
pub extern "C" fn dio_verb_events_ptr() -> *const diomano_sim::world::VerbEvent {
    world().census.verb_events.as_ptr()
}

/// Total verb events ever recorded. The renderer keeps its own high-water mark and
/// reads forward, so it may lag without losing sync.
#[unsafe(no_mangle)]
pub extern "C" fn dio_verb_events_written() -> u32 {
    world().census.verb_events_written
}

// ---------------------------------------------------------------------------
// Mesh pointers
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_positions_ptr() -> *const f32 {
    mesh_buf().positions.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_normals_ptr() -> *const f32 {
    mesh_buf().normals.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_attribs_ptr() -> *const u8 {
    mesh_buf().attribs.as_ptr()
}

/// Per vertex: lava depth, fertility, sediment, spare.
#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_attribs2_ptr() -> *const u8 {
    mesh_buf().attribs2.as_ptr()
}

/// Per vertex: rock, sand, soil and ash weights. Swamp is `255 - sum`.
#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_attribs3_ptr() -> *const u8 {
    mesh_buf().attribs3.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_water_positions_ptr() -> *const f32 {
    mesh_buf().water_positions.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_water_attribs_ptr() -> *const u8 {
    mesh_buf().water_attribs.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_indices_ptr() -> *const u16 {
    mesh_buf().indices.as_ptr()
}

/// One byte per chunk: 1 where the last [`dio_mesh_update`] rebuilt it.
#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_dirty_ptr() -> *const u8 {
    mesh_buf().dirty.as_ptr()
}

/// One byte per chunk: 1 where the chunk contains any water.
#[unsafe(no_mangle)]
pub extern "C" fn dio_mesh_water_present_ptr() -> *const u8 {
    mesh_buf().water_present.as_ptr()
}

// ---------------------------------------------------------------------------
// Layout constants
//
// Exported rather than duplicated in TypeScript: two copies of `N` is one copy
// too many, and the failure mode is a silently misaligned typed-array view.
// ---------------------------------------------------------------------------

macro_rules! konst {
    ($name:ident, $value:expr) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name() -> u32 {
            $value as u32
        }
    };
}

konst!(dio_grid_n, diomano_sim::world::N);
konst!(dio_grid_stride, diomano_sim::world::S);
konst!(dio_cell_count, diomano_sim::world::CELLS);
konst!(dio_max_walkers, diomano_sim::world::MAX_WALKERS);
konst!(dio_max_settlements, diomano_sim::world::MAX_SETTLEMENTS);
konst!(dio_max_pickups, diomano_sim::world::MAX_PICKUPS);
konst!(dio_pickup_stride, core::mem::size_of::<Pickup>());
konst!(dio_verb_event_capacity, diomano_sim::world::VERB_EVENTS);
konst!(dio_verb_event_stride, core::mem::size_of::<diomano_sim::world::VerbEvent>());
konst!(dio_walker_stride, core::mem::size_of::<Walker>());
konst!(dio_settlement_stride, core::mem::size_of::<Settlement>());
konst!(dio_chunk_cells, mesh::CHUNK);
konst!(dio_chunk_count, mesh::CHUNKS);
konst!(dio_verts_per_chunk, mesh::VERTS_PER_CHUNK);
konst!(dio_indices_per_chunk, mesh::INDICES_PER_CHUNK);
konst!(dio_total_verts, mesh::TOTAL_VERTS);
konst!(dio_tick_hz, diomano_sim::TICK_HZ);

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn dio_tick_count() -> u32 {
    world().tick
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_sea_level() -> i32 {
    i32::from(world().sea_level)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_tide_phase() -> u32 {
    u32::from(world().tide.phase)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_tide_wave() -> u32 {
    u32::from(world().tide.wave)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_tide_offset() -> i32 {
    i32::from(world().tide.offset)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_tide_strength() -> i32 {
    i32::from(world().tide.strength)
}

/// Ticks until the current wave lands. The renderer turns this into a swell and
/// a horizon tint; §8 forbids turning it into a bar.
#[unsafe(no_mangle)]
pub extern "C" fn dio_ticks_to_impact() -> u32 {
    tide::ticks_to_impact(world())
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_mana(player: u32) -> i32 {
    world().mana_units((player as usize) % PLAYERS)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_hand_amount(player: u32) -> u32 {
    u32::from(world().hand[(player as usize) % PLAYERS].amount)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_hand_material(player: u32) -> u32 {
    u32::from(world().hand[(player as usize) % PLAYERS].material)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_hand_capacity() -> u32 {
    u32::from(diomano_sim::world::HAND_CAPACITY)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_walker_count(player: u32) -> u32 {
    u32::from(world().walker_count[(player as usize) % PLAYERS])
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_magnet_active(player: u32) -> u32 {
    u32::from(world().magnet[(player as usize) % PLAYERS].active)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_magnet_face(player: u32) -> u32 {
    u32::from(world().magnet[(player as usize) % PLAYERS].face)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_magnet_x(player: u32) -> u32 {
    u32::from(world().magnet[(player as usize) % PLAYERS].x)
}

/// Free single-use charges collected from pickups (§5.3).
#[unsafe(no_mangle)]
pub extern "C" fn dio_free_uses(player: u32, power: u32) -> u32 {
    let w = world();
    let p = (player as usize) % PLAYERS;
    let k = (power as usize).min(diomano_sim::world::POWER_COUNT - 1);
    u32::from(w.free_uses[p][k])
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_magnet_y(player: u32) -> u32 {
    u32::from(world().magnet[(player as usize) % PLAYERS].y)
}

/// Whether a power is enabled in this map's manifest. Exported rather than
/// mirrored: the manifest can change both per map, and the power menu grays
/// or omits entries from what the sim will actually accept.
#[unsafe(no_mangle)]
pub extern "C" fn dio_power_enabled(power: u32) -> u32 {
    let w = world();
    let k = (power as usize).min(diomano_sim::world::POWER_COUNT - 1);
    u32::from(w.cfg.power_enabled[k])
}

/// A power's mana cost in this map's manifest, in whole mana units.
#[unsafe(no_mangle)]
pub extern "C" fn dio_power_cost(power: u32) -> u32 {
    let w = world();
    let k = (power as usize).min(diomano_sim::world::POWER_COUNT - 1);
    u32::from(w.cfg.power_cost[k])
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_outcome() -> u32 {
    u32::from(world().outcome)
}

/// How many waves this match plays, so the client can bound a score readout.
#[unsafe(no_mangle)]
pub extern "C" fn dio_wave_count() -> u32 {
    u32::from(world().cfg.waves)
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_score(player: u32, wave: u32) -> u32 {
    let w = world();
    let p = (player as usize) % PLAYERS;
    let i = (wave as usize).min(diomano_sim::world::MAX_WAVES - 1);
    u32::from(w.score[p][i])
}

/// State hash, split because the ABI is 32-bit and JavaScript numbers cannot
/// carry 64 bits of integer exactly.
#[unsafe(no_mangle)]
pub extern "C" fn dio_state_hash_lo() -> u32 {
    world().state_hash() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_state_hash_hi() -> u32 {
    (world().state_hash() >> 32) as u32
}

// ---------------------------------------------------------------------------
// Headless replay, for `just verify-cross`
// ---------------------------------------------------------------------------

/// Scratch buffer the host writes a session log into before calling
/// [`dio_replay`]. 256 KB is far more than any fixture this project will record.
const LOG_CAPACITY: usize = 256 * 1024;
static LOG: Global<[u8; LOG_CAPACITY]> = Global::new([0; LOG_CAPACITY]);
/// Hashes produced by the last replay: `(tick, lo, hi)` triples.
const HASH_CAPACITY: usize = 4096 * 3;
static HASHES: Global<[u32; HASH_CAPACITY]> = Global::new([0; HASH_CAPACITY]);
static HASH_LEN: Global<u32> = Global::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn dio_log_ptr() -> *mut u8 {
    LOG.get().as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_log_capacity() -> u32 {
    LOG_CAPACITY as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_replay_hashes_ptr() -> *const u32 {
    HASHES.get().as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn dio_replay_hash_count() -> u32 {
    *HASH_LEN.get()
}

/// Replay the first `len` bytes of the log buffer.
///
/// This is the browser half of `just verify-cross`. It runs the identical crate
/// the native verifier runs, so a disagreement between them is a real
/// divergence and not a difference in harness — which is the entire reason the
/// simulation is a separate crate.
///
/// Returns 0 on success, or the 1-based line number of a parse error.
#[unsafe(no_mangle)]
pub extern "C" fn dio_replay(len: u32) -> u32 {
    let n = (len as usize).min(LOG_CAPACITY);
    let bytes = &LOG.get()[..n];
    let Ok(src) = core::str::from_utf8(bytes) else {
        return u32::MAX;
    };

    let header = match powers::parse_log_header(src) {
        Ok(h) => h,
        Err(e) => return e.line,
    };
    let w = world();
    w.init(&header.cfg);

    let hashes = HASHES.get();
    let mut out = 0usize;

    // No allocator, so commands are not collected up front: the log is scanned
    // once per tick from a moving cursor. The log is written in tick order, so
    // this is a single forward pass overall.
    let mut lines = src.lines().peekable();
    let mut pending: Option<Command> = None;

    for tick in 0..header.ticks {
        let mut buf = CommandBuf::new();
        loop {
            if pending.is_none() {
                pending = loop {
                    match lines.peek() {
                        None => break None,
                        Some(line) => {
                            let parsed = powers::parse_log_command(line);
                            lines.next();
                            if let Some(c) = parsed {
                                break Some(c);
                            }
                        }
                    }
                };
            }
            match pending {
                Some(c) if c.tick == tick => {
                    buf.push(c);
                    pending = None;
                }
                _ => break,
            }
        }
        w.tick(buf.as_slice());
        if tick % 30 == 0 && out + 3 <= HASH_CAPACITY {
            let h = w.last_hash;
            hashes[out] = tick;
            hashes[out + 1] = h as u32;
            hashes[out + 2] = (h >> 32) as u32;
            out += 3;
        }
    }
    *HASH_LEN.get() = (out / 3) as u32;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, not several.
    ///
    /// The shell owns exactly one world, in a `static`, because that is the
    /// point: no allocator, no growth, no detached views. Rust runs `#[test]`
    /// functions on parallel threads, so several tests would race over that one
    /// world and fail in a way that looks like a determinism bug and is not.
    /// Keeping the shell's tests in a single sequential function is the honest
    /// expression of a single-world design.
    #[test]
    fn the_shell_is_a_faithful_pass_through() {
        // --- layout ---------------------------------------------------------
        dio_init(0x5EED, 0, 0);
        assert_eq!(dio_grid_n(), diomano_sim::world::N as u32);
        assert_eq!(dio_grid_stride(), dio_grid_n() + 2);
        assert_eq!(dio_cell_count(), 6 * dio_grid_stride() * dio_grid_stride());
        assert_eq!(dio_total_verts(), dio_chunk_count() * dio_verts_per_chunk());
        assert!(dio_walker_stride() >= 18);
        assert_eq!(dio_tick_hz(), diomano_sim::TICK_HZ);

        // --- ticking matches the crate directly -----------------------------
        dio_init(1234, 1, 0);
        for _ in 0..200 {
            dio_tick();
        }
        let via_shell = (u64::from(dio_state_hash_hi()) << 32) | u64::from(dio_state_hash_lo());

        let mut cfg = MapConfig::DEFAULT;
        cfg.seed = 1234;
        cfg.terrain = 1;
        let mut w = World::boxed();
        w.init(&cfg);
        for _ in 0..200 {
            w.tick(&[]);
        }
        assert_eq!(via_shell, w.state_hash(), "the shell is not a pass-through");

        // --- queued commands apply once -------------------------------------
        dio_init(9, 1, 0);
        let before = dio_hand_amount(0);
        dio_push_command(0, u32::from(diomano_sim::world::VERB_LOWER), 4, 32, 32, 0);
        dio_tick();
        let after = dio_hand_amount(0);
        assert!(after > before, "the queued command did not apply");
        dio_tick();
        assert_eq!(dio_hand_amount(0), after, "a command applied twice");

        // --- headless replay agrees with the native replay ------------------
        //
        // This is `just verify-cross` in miniature: the browser path and the
        // native path, over the same log, must produce the same hashes. Running
        // it here catches a shell-side mistake before Playwright is involved.
        let log = "seed 4242\nn 64\nterrain 1\nticks 300\n\
                   c 10 0 2 4 32 32 0\nc 40 0 1 4 30 30 1\nc 90 0 3 4 20 20 0\n";
        let bytes = log.as_bytes();
        LOG.get()[..bytes.len()].copy_from_slice(bytes);
        assert_eq!(dio_replay(bytes.len() as u32), 0);

        let count = dio_replay_hash_count() as usize;
        assert!(count > 0);
        let hashes = &HASHES.get()[..count * 3];

        let (_, native) = powers::replay(log).expect("native replay");
        assert_eq!(native.len(), count, "hash counts differ");
        for (i, (tick, h)) in native.iter().enumerate() {
            assert_eq!(hashes[i * 3], *tick);
            let got = (u64::from(hashes[i * 3 + 2]) << 32) | u64::from(hashes[i * 3 + 1]);
            assert_eq!(got, *h, "hash {i} differs at tick {tick}");
        }
    }
}
