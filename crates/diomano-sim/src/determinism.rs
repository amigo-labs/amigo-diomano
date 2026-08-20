//! The tests that decide whether any of this is worth having.
//!
//! HANDOFF §7 (design pillars): "Determinism is a design constraint, not an
//! implementation detail." §10 lists the rules; these are the checks that the
//! rules are actually being followed, rather than merely written down.
//!
//! A determinism bug is not a crash. It is two clients quietly disagreeing
//! about who won, half an hour in. Nothing else in the test suite will find it.

use crate::world::{
    Command, CommandBuf, MAX_COMMANDS_PER_TICK, MOD_THROWN, MapConfig, N, TERRAIN_ARCHIPELAGO,
    VERB_LOWER, VERB_MAGNET, VERB_RAISE, VERB_VOLCANO, World,
};
use alloc::boxed::Box;
use std::vec::Vec;

fn config(seed: u32) -> MapConfig {
    let mut cfg = MapConfig::DEFAULT;
    cfg.seed = seed;
    cfg.terrain = TERRAIN_ARCHIPELAGO;
    // Mana costs off, so the scripted input below always lands. A command that
    // is silently refused for lack of mana would still replay identically, but
    // it would test far less of the world.
    cfg.power_cost = [0; crate::world::POWER_COUNT];
    cfg
}

/// A deterministic input script: the same commands, at the same ticks, for both
/// runs. Derived from the tick number alone, so it cannot pick up any hidden
/// state from the world it is driving.
fn script(tick: u32, buf: &mut CommandBuf) {
    let n = N as u16;
    let step = (tick / 7) as u16;
    match tick % 97 {
        0..=20 => buf.push(Command {
            tick,
            x: (step * 3) % n,
            y: (step * 5) % n,
            player: (tick % 2) as u8,
            verb: VERB_LOWER,
            face: (tick % 6) as u8,
            modifier: if tick.is_multiple_of(3) { MOD_THROWN } else { 0 },
        }),
        21..=45 => buf.push(Command {
            tick,
            x: (step * 7 + 3) % n,
            y: (step * 11 + 1) % n,
            player: (tick % 2) as u8,
            verb: VERB_RAISE,
            face: ((tick / 3) % 6) as u8,
            modifier: MOD_THROWN,
        }),
        60 => buf.push(Command {
            tick,
            x: (step * 13) % n,
            y: (step * 17) % n,
            player: (tick % 2) as u8,
            verb: VERB_MAGNET,
            face: ((tick / 11) % 6) as u8,
            modifier: 0,
        }),
        80 => buf.push(Command {
            tick,
            x: (step * 19) % n,
            y: (step * 23) % n,
            player: (tick % 2) as u8,
            verb: VERB_VOLCANO,
            face: ((tick / 5) % 6) as u8,
            modifier: 0,
        }),
        _ => {}
    }
}

fn run(seed: u32, ticks: u32) -> Vec<u64> {
    let mut w = World::boxed();
    w.init(&config(seed));
    let mut out = Vec::with_capacity(ticks as usize);
    for tick in 0..ticks {
        let mut buf = CommandBuf::new();
        script(tick, &mut buf);
        w.tick(buf.as_slice());
        out.push(w.state_hash());
    }
    out
}

/// Two independent runs in one process, 10,000 ticks, identical hash sequences.
///
/// "In one process" is the load-bearing part. A `HashMap` seeded from
/// `RandomState` is stable within a process, so a cross-process comparison would
/// pass while the §10 rule was being broken. Running both worlds in the same
/// process instead catches shared mutable state, allocator-address dependence
/// and iteration-order leaks — and `cross_build_hash_matches` covers the
/// cross-process axis separately.
#[test]
fn same_seed_same_hash_10k_ticks() {
    const TICKS: u32 = 10_000;
    let a = run(0x5EED, TICKS);
    let b = run(0x5EED, TICKS);
    assert_eq!(a.len(), TICKS as usize);

    if let Some(t) = (0..a.len()).find(|&i| a[i] != b[i]) {
        panic!("diverged at tick {t}: {:#018x} vs {:#018x}", a[t], b[t]);
    }

    // A run that never changes is trivially reproducible and proves nothing.
    let distinct = {
        let mut v = a.clone();
        v.sort_unstable();
        v.dedup();
        v.len()
    };
    assert!(distinct > TICKS as usize / 2, "the world barely changed over {TICKS} ticks");

    // And a different seed must not agree, or the hash is not sensitive.
    let c = run(0x5EED + 1, 300);
    assert_ne!(a[..300], c[..], "two different seeds produced the same history");
}

/// Interleaving two worlds tick-for-tick is a sharper version of the same test:
/// any state shared between them shows up immediately instead of after one run
/// has finished with it.
#[test]
fn interleaved_worlds_do_not_contaminate_each_other() {
    let mut a = World::boxed();
    let mut b = World::boxed();
    let mut solo = World::boxed();
    a.init(&config(7));
    b.init(&config(7));
    solo.init(&config(7));

    for tick in 0..1500u32 {
        let mut buf = CommandBuf::new();
        script(tick, &mut buf);
        a.tick(buf.as_slice());
        b.tick(buf.as_slice());
        assert_eq!(a.state_hash(), b.state_hash(), "interleaved worlds diverged at tick {tick}");
    }
    for tick in 0..1500u32 {
        let mut buf = CommandBuf::new();
        script(tick, &mut buf);
        solo.tick(buf.as_slice());
    }
    assert_eq!(a.state_hash(), solo.state_hash(), "interleaving changed the outcome");
}

/// The CLI replays `fixtures/session.log` and the recorded hash sequence in
/// `fixtures/session.hashes` matches exactly.
///
/// This is the cross-*build* axis: the fixture was produced by an earlier build
/// and is committed, so a change that alters simulation behaviour fails here
/// even when it is perfectly self-consistent. Regenerating the fixture to make
/// this pass is always a decision, never a fix.
#[test]
fn cross_build_hash_matches() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("workspace root")
        .to_path_buf();
    let log_path = root.join("fixtures/session.log");
    let hash_path = root.join("fixtures/session.hashes");

    let log = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", log_path.display()));
    let expected_src = std::fs::read_to_string(&hash_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", hash_path.display()));

    let (_, actual) = crate::powers::replay(&log).expect("fixture log must parse");

    let expected: Vec<(u32, u64)> = expected_src
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let (t, h) = l.split_once(' ').expect("hash line is `<tick> <hex>`");
            (
                t.parse::<u32>().expect("tick"),
                u64::from_str_radix(h.trim().trim_start_matches("0x"), 16).expect("hash"),
            )
        })
        .collect();

    assert!(!expected.is_empty(), "the hash fixture is empty");
    assert_eq!(
        actual.len(),
        expected.len(),
        "replay produced {} hashes, fixture has {}",
        actual.len(),
        expected.len()
    );
    for (i, (got, want)) in actual.iter().zip(expected.iter()).enumerate() {
        assert_eq!(
            got, want,
            "hash {i} differs at tick {}: got {:#018x}, fixture says {:#018x}",
            got.0, got.1, want.1
        );
    }
}

/// Replaying the same log twice must also agree, which separates "the fixture is
/// stale" from "replay is not reproducible" when the test above fails.
#[test]
fn replay_is_reproducible() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("workspace root")
        .to_path_buf();
    let Ok(log) = std::fs::read_to_string(root.join("fixtures/session.log")) else {
        return;
    };
    let (a, ah) = crate::powers::replay(&log).expect("parse");
    let (b, bh) = crate::powers::replay(&log).expect("parse");
    assert_eq!(ah, bh);
    assert_eq!(a.state_hash(), b.state_hash());
}

/// Overflow must not be a source of divergence between profiles.
///
/// `overflow-checks` is on in every profile (workspace `Cargo.toml`), so a wrap
/// panics identically in debug and release. This test drives the arithmetic to
/// its extremes and asserts the world survives — if it panics, the fix is an
/// explicit `saturating_*`, not turning the checks off.
#[test]
fn extreme_values_do_not_overflow_any_pass() {
    let mut w = World::boxed();
    w.init(&config(11));
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = crate::world::idx(face, x, y);
                w.height[c] = if (x + y) % 2 == 0 {
                    crate::world::HEIGHT_MAX
                } else {
                    crate::world::HEIGHT_MIN
                };
                w.water[c] = i16::MAX;
                w.lava[c] = 255;
                w.sediment[c] = 255;
                w.fertility[c] = 255;
                w.vegetation[c] = 255;
                w.influence[c] = if x % 2 == 0 { 127 } else { -127 };
                w.dry_ticks[c] = u16::MAX;
            }
        }
    }
    w.sea_base = i16::MAX / 2;
    w.mana = [i32::MAX, i32::MAX];
    for tick in 0..200u32 {
        let mut buf = CommandBuf::new();
        script(tick, &mut buf);
        w.tick(buf.as_slice());
    }
}

#[test]
fn a_full_command_buffer_drops_rather_than_grows() {
    // No allocation inside a tick (§9.4). Overflow is deterministic truncation.
    let mut buf = CommandBuf::new();
    for i in 0..MAX_COMMANDS_PER_TICK * 3 {
        buf.push(Command { tick: i as u32, ..Command::default() });
    }
    assert_eq!(buf.len as usize, MAX_COMMANDS_PER_TICK);
    assert_eq!(buf.as_slice().len(), MAX_COMMANDS_PER_TICK);
    assert_eq!(buf.as_slice()[0].tick, 0);
}

#[test]
fn the_world_is_a_plain_old_data_type() {
    // `World::boxed` hands back `alloc_zeroed` memory and calls it a `World`.
    // That is only sound while every field is an integer array; a `Vec`, an
    // `Option<&T>` or a niche-carrying enum would make it undefined behaviour.
    // `needs_drop` is the check that catches all three.
    assert!(!core::mem::needs_drop::<World>(), "World acquired a field that needs dropping");
    assert!(!core::mem::needs_drop::<crate::mesh::Mesh>(), "Mesh acquired a droppable field");
    let _: Box<World> = World::boxed();
}

#[test]
fn tick_order_is_the_order_the_spec_lists() {
    // A guard against reordering by accident. `World::tick` is short and its
    // comments carry the §4.1 numbering; this asserts the observable consequence
    // that matters most: the tide moves sea level before water reads it.
    let mut cfg = config(3);
    cfg.telegraph_ticks = 1;
    cfg.impact_ticks = 4;
    cfg.recovery_ticks = 1;
    cfg.wave_strength = 2000;
    let mut w = World::boxed();
    w.init(&cfg);
    let mut saw_flood = false;
    for _ in 0..40 {
        w.tick(&[]);
        if w.tide.offset > 0 {
            // Sea level and the water field must agree within the same tick.
            // Probe a rock cell: granular material can erode *after* the water
            // pass within the same tick, which shaves a few units off
            // `height + water` without any tide/water misordering — a tide
            // running after water would leave an offset-sized gap, and rock's
            // height no pass can move, so on rock the equality is exact.
            let c = (0..6)
                .flat_map(|f| (0..N).flat_map(move |y| (0..N).map(move |x| (f, x, y))))
                .map(|(f, x, y)| crate::world::idx(f, x, y))
                .find(|&c| {
                    i32::from(w.height[c]) < i32::from(w.sea_level)
                        && w.material[c] == crate::world::MAT_ROCK
                });
            if let Some(c) = c {
                assert!(
                    i32::from(w.height[c]) + i32::from(w.water[c]) >= i32::from(w.sea_level),
                    "a cell below sea level was left dry: the tide runs after the water pass"
                );
                saw_flood = true;
            }
        }
    }
    assert!(saw_flood, "the tide never rose during the test window");
}
