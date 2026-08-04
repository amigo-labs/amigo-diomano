//! Native replay verifier and performance harness.
//!
//! HANDOFF §9.2, reason 3: the same crate compiles to WebAssembly for the
//! browser and to a binary here. Replay an input log natively, compare per-tick
//! hashes, pin a desync to an exact tick. For lockstep debugging that is the
//! difference between an hour and a week.
//!
//! Nothing in this file is game logic. If a behaviour is only reachable through
//! the CLI, it is in the wrong crate.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use diomano_sim::mesh::Mesh;
use diomano_sim::world::{
    Command, CommandBuf, MapConfig, N, TERRAIN_ARCHIPELAGO, TERRAIN_PANGAEA, TERRAIN_VOLCANO,
    VERB_LOWER, VERB_MAGNET, VERB_RAISE, VERB_VOLCANO, World,
};
use diomano_sim::{
    TICK_HZ, VERSION, combat, flowfield, materials, powers, settlements, tide, walkers, water,
};

const USAGE: &str = "\
diomano-cli — native replay verifier and perf harness

USAGE:
  diomano-cli version
  diomano-cli hash    [--seed N] [--ticks N] [--terrain NAME] [--every N]
  diomano-cli perf    [--ticks N] [--seed N] [--terrain NAME]
  diomano-cli replay  <file> [--verify]
  diomano-cli record  [--out fixtures/session.log] [--seed N] [--ticks N]

TERRAIN: archipelago | pangaea | volcano
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        eprint!("{USAGE}");
        return ExitCode::FAILURE;
    };
    let opts = Opts::parse(&args[1..]);

    let result = match cmd {
        "version" => {
            println!("diomano-cli {VERSION} (sim {VERSION}, N = {N}, {TICK_HZ} Hz)");
            Ok(())
        }
        "hash" => cmd_hash(&opts),
        "perf" => cmd_perf(&opts),
        "replay" => cmd_replay(&opts),
        "record" => cmd_record(&opts),
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            Ok(())
        }
        other => Err(format!("unknown subcommand `{other}`\n\n{USAGE}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

struct Opts {
    positional: Vec<String>,
    seed: u32,
    ticks: u32,
    every: u32,
    terrain: u8,
    verify: bool,
    out: PathBuf,
    hashes_out: PathBuf,
}

impl Opts {
    fn parse(args: &[String]) -> Self {
        let mut o = Self {
            positional: Vec::new(),
            seed: 0x5EED,
            ticks: 3_000,
            every: 30,
            terrain: TERRAIN_ARCHIPELAGO,
            verify: false,
            out: PathBuf::from("fixtures/session.log"),
            hashes_out: PathBuf::from("fixtures/session.hashes"),
        };
        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            let mut value = || {
                i += 1;
                args.get(i).cloned().unwrap_or_default()
            };
            match a {
                "--seed" => o.seed = parse_u32(&value()),
                "--ticks" => o.ticks = parse_u32(&value()),
                "--every" => o.every = parse_u32(&value()).max(1),
                "--out" => o.out = PathBuf::from(value()),
                "--hashes" => o.hashes_out = PathBuf::from(value()),
                "--terrain" => {
                    o.terrain = match value().as_str() {
                        "pangaea" => TERRAIN_PANGAEA,
                        "volcano" => TERRAIN_VOLCANO,
                        _ => TERRAIN_ARCHIPELAGO,
                    };
                }
                "--verify" => o.verify = true,
                other => o.positional.push(other.to_string()),
            }
            i += 1;
        }
        o
    }

    fn config(&self) -> MapConfig {
        let mut cfg = MapConfig::DEFAULT;
        cfg.seed = self.seed;
        cfg.terrain = self.terrain;
        cfg
    }
}

fn parse_u32(s: &str) -> u32 {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16).unwrap_or(0)
    } else {
        s.parse().unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

/// Tick a world from a seed and print a hash per tick.
///
/// The correctness instrument for everything else: two runs, `diff`, done.
fn cmd_hash(o: &Opts) -> Result<(), String> {
    let mut w = World::boxed();
    w.init(&o.config());
    println!("# diomano hash seed={:#x} n={N} terrain={} ticks={}", o.seed, o.terrain, o.ticks);
    for tick in 0..o.ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, &mut buf);
        w.tick(buf.as_slice());
        if tick % o.every == 0 {
            println!("{tick} {:#018x}", w.state_hash());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// perf
// ---------------------------------------------------------------------------

/// Per-pass timings, in the §4.1 pass order.
///
/// The passes are driven individually here rather than through `World::tick`,
/// because the simulation may not read a clock (§10) — so the harness has to
/// live outside it. The sequence below must stay identical to `World::tick`; the
/// assertion at the end checks that it produced the same state.
#[expect(
    clippy::disallowed_types,
    reason = "the perf harness is outside the simulation, which is exactly why it \
              may read a clock; §10 bans wall-clock time *inside* the sim"
)]
fn cmd_perf(o: &Opts) -> Result<(), String> {
    use std::time::Instant;

    let ticks = if o.ticks == 3_000 { 600 } else { o.ticks };
    let mut w = World::boxed();
    w.init(&o.config());
    let mut mesh = Mesh::boxed();
    mesh.rebuild_all(&w);

    const PASSES: usize = 12;
    const NAMES: [&str; PASSES] = [
        "1  ghost border copy",
        "2  command application",
        "2a tide",
        "3  water transfer",
        "4  lava transfer",
        "5  material interactions",
        "6  granular movement",
        "7  vegetation growth",
        "8  walker movement",
        "9  combat resolution",
        "10 settlements",
        "11 flow field + influence",
    ];
    let mut total = [0u128; PASSES];
    let mut extra_mana = 0u128;
    let mut extra_hash = 0u128;
    let mut extra_mesh = 0u128;
    let mut chunks_remeshed = 0u64;

    // Warm up, so the first tick's page faults are not charged to pass 1.
    for _ in 0..30 {
        w.tick(&[]);
    }

    let wall = Instant::now();
    for tick in 0..ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, &mut buf);

        let mut t = Instant::now();
        let lap = |slot: usize, t: &mut Instant, total: &mut [u128; PASSES]| {
            total[slot] += t.elapsed().as_nanos();
            *t = Instant::now();
        };

        w.ghost_copy_all();
        lap(0, &mut t, &mut total);
        w.apply_commands(buf.as_slice());
        lap(1, &mut t, &mut total);
        tide::step(&mut w);
        lap(2, &mut t, &mut total);
        water::transfer_water(&mut w);
        lap(3, &mut t, &mut total);
        water::transfer_lava(&mut w);
        lap(4, &mut t, &mut total);
        materials::interactions(&mut w);
        lap(5, &mut t, &mut total);
        materials::granular(&mut w);
        lap(6, &mut t, &mut total);
        materials::vegetation(&mut w);
        lap(7, &mut t, &mut total);
        walkers::movement(&mut w);
        lap(8, &mut t, &mut total);
        combat::resolve(&mut w);
        lap(9, &mut t, &mut total);
        settlements::update(&mut w);
        lap(10, &mut t, &mut total);
        if w.tick.is_multiple_of(15) {
            flowfield::rebuild(&mut w);
            flowfield::project(&mut w);
        }
        lap(11, &mut t, &mut total);
        w.accrue_mana();
        extra_mana += t.elapsed().as_nanos();
        t = Instant::now();
        if w.tick.is_multiple_of(30) {
            w.last_hash = w.state_hash();
        }
        extra_hash += t.elapsed().as_nanos();
        w.tick = w.tick.wrapping_add(1);

        // Meshing is render work and is reported separately: it does not
        // compete for the 12 ms simulation budget, it competes for the other 21.
        let t = Instant::now();
        chunks_remeshed += u64::from(mesh.update(&w));
        extra_mesh += t.elapsed().as_nanos();
    }
    let wall = wall.elapsed();

    let f = f64::from(ticks);
    let ms = |ns: u128| ns as f64 / 1e6 / f;

    println!("diomano perf — N = {N}, {} live cells, {ticks} ticks", 6 * N * N);
    println!("seed {:#x}, terrain {}\n", o.seed, o.terrain);
    println!("{:<28} {:>10}  {:>7}", "pass", "ms/tick", "% of sim");

    let sim_total: u128 = total.iter().sum::<u128>() + extra_mana + extra_hash;
    for (i, name) in NAMES.iter().enumerate() {
        let share = if sim_total == 0 { 0.0 } else { total[i] as f64 * 100.0 / sim_total as f64 };
        println!("{name:<28} {:>10.4}  {share:>6.1}%", ms(total[i]));
    }
    println!(
        "{:<28} {:>10.4}  {:>6.1}%",
        "12 mana accrual",
        ms(extra_mana),
        extra_mana as f64 * 100.0 / sim_total as f64
    );
    println!(
        "{:<28} {:>10.4}  {:>6.1}%",
        "13 state hash",
        ms(extra_hash),
        extra_hash as f64 * 100.0 / sim_total as f64
    );
    println!("{:-<48}", "");
    let sim_ms = ms(sim_total);
    println!("{:<28} {:>10.4}", "SIMULATION TOTAL", sim_ms);
    println!(
        "{:<28} {:>10.4}   ({:.1} chunks/tick)",
        "meshing (render budget)",
        ms(extra_mesh),
        chunks_remeshed as f64 / f
    );
    println!("{:<28} {:>10.4}", "wall clock per tick", wall.as_nanos() as f64 / 1e6 / f);

    // §4.1: 33.3 ms per frame at 30 Hz, split 12 ms simulation / 21 ms render.
    const SIM_BUDGET_MS: f64 = 12.0;
    let headroom = SIM_BUDGET_MS / sim_ms;
    println!("\nbudget: {SIM_BUDGET_MS} ms/tick simulation (HANDOFF §4.1)");
    println!("used:   {:.1}% of budget, {headroom:.1}x headroom", sim_ms * 100.0 / SIM_BUDGET_MS);
    if sim_ms > SIM_BUDGET_MS {
        println!("\nOVER BUDGET. Reduce N — never the tick rate (§4.1).");
        println!("N would need to be about {}", (N as f64 * headroom.sqrt()) as usize / 2 * 2);
    } else {
        // What N could be afforded, if the cost were purely per-cell.
        let afford = (N as f64 * headroom.sqrt()) as usize;
        println!("headroom suggests N up to ~{} on this machine", afford / 16 * 16);
    }
    println!(
        "\nNOTE: HANDOFF §7.6 — the reference floor is integrated graphics, not this\n\
         machine. A number measured here is an upper bound, not the budget."
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

fn cmd_replay(o: &Opts) -> Result<(), String> {
    let path = o.positional.first().ok_or("replay needs a log file")?;
    let src = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let (w, hashes) = powers::replay(&src).map_err(|e| format!("{path}:{}: {}", e.line, e.what))?;

    if !o.verify {
        for (tick, h) in &hashes {
            println!("{tick} {h:#018x}");
        }
        println!("# final {:#018x} after {} ticks", w.state_hash(), w.tick);
        return Ok(());
    }

    let expected_path = sibling_hashes(Path::new(path));
    let expected_src = std::fs::read_to_string(&expected_path)
        .map_err(|e| format!("cannot read {}: {e}", expected_path.display()))?;
    let expected = parse_hashes(&expected_src)?;

    if expected.len() != hashes.len() {
        return Err(format!(
            "replay produced {} hashes, {} has {}",
            hashes.len(),
            expected_path.display(),
            expected.len()
        ));
    }
    for (i, (got, want)) in hashes.iter().zip(expected.iter()).enumerate() {
        if got != want {
            let mut msg = String::new();
            let _ = writeln!(msg, "DESYNC at hash {i} (tick {})", got.0);
            let _ = writeln!(msg, "  replay   {:#018x}", got.1);
            let _ = writeln!(msg, "  fixture  {:#018x}", want.1);
            let _ = write!(
                msg,
                "  the previous {} hashes matched, so divergence began in ticks {}..={}",
                i,
                want.0.saturating_sub(30),
                want.0
            );
            return Err(msg);
        }
    }
    println!(
        "OK — {} hashes over {} ticks match {}",
        hashes.len(),
        w.tick,
        expected_path.display()
    );
    Ok(())
}

fn sibling_hashes(log: &Path) -> PathBuf {
    log.with_extension("hashes")
}

fn parse_hashes(src: &str) -> Result<Vec<(u32, u64)>, String> {
    src.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let (t, h) = l.split_once(' ').ok_or_else(|| format!("bad hash line: {l}"))?;
            let tick = t.parse::<u32>().map_err(|e| format!("bad tick in `{l}`: {e}"))?;
            let hash = u64::from_str_radix(h.trim().trim_start_matches("0x"), 16)
                .map_err(|e| format!("bad hash in `{l}`: {e}"))?;
            Ok((tick, hash))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

/// Write a session log and its hash sequence.
///
/// The log is the input; the hashes are what the input is *supposed* to produce.
/// Committing both is what makes `cross_build_hash_matches` a regression test
/// rather than a tautology.
fn cmd_record(o: &Opts) -> Result<(), String> {
    let ticks = o.ticks;
    let mut log = String::new();
    let _ = writeln!(log, "# diomano session log v1 — generated by `diomano-cli record`");
    let _ = writeln!(log, "# commands: c <tick> <player> <verb> <face> <x> <y> <modifier>");
    let _ = writeln!(log, "seed {}", o.seed);
    let _ = writeln!(log, "n {N}");
    let _ = writeln!(log, "terrain {}", o.terrain);
    let _ = writeln!(log, "ticks {ticks}");

    for tick in 0..ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, &mut buf);
        for c in buf.as_slice() {
            let _ = writeln!(
                log,
                "c {} {} {} {} {} {} {}",
                c.tick, c.player, c.verb, c.face, c.x, c.y, c.modifier
            );
        }
    }

    let (_, hashes) = powers::replay(&log).map_err(|e| format!("line {}: {}", e.line, e.what))?;
    let mut out = String::new();
    let _ = writeln!(out, "# state hashes for session.log, one per 30 ticks");
    for (tick, h) in &hashes {
        let _ = writeln!(out, "{tick} {h:#018x}");
    }

    if let Some(dir) = o.out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&o.out, &log).map_err(|e| format!("cannot write {}: {e}", o.out.display()))?;
    std::fs::write(&o.hashes_out, &out)
        .map_err(|e| format!("cannot write {}: {e}", o.hashes_out.display()))?;
    println!(
        "wrote {} ({} bytes) and {} ({} hashes over {ticks} ticks)",
        o.out.display(),
        log.len(),
        o.hashes_out.display(),
        hashes.len()
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// The scripted session
// ---------------------------------------------------------------------------

/// A deterministic input script covering every verb the CLI can reach.
///
/// Shared by `hash`, `perf` and `record` so that a fixture, a timing run and a
/// determinism check all exercise the same code paths. Depends on the tick
/// number and nothing else — a script that read the world would make the log
/// meaningless, because the log is supposed to be the *input*.
fn demo_script(tick: u32, buf: &mut CommandBuf) {
    let n = N as u16;
    let s = (tick / 5) as u16;
    let player = (tick / 400 % 2) as u8;
    let face = ((tick / 137) % 6) as u8;

    match tick % 200 {
        5..=40 => buf.push(Command {
            tick,
            x: (s * 3 + 7) % n,
            y: (s * 5 + 11) % n,
            player,
            verb: VERB_LOWER,
            face,
            modifier: u8::from(tick.is_multiple_of(4)),
        }),
        50..=95 => buf.push(Command {
            tick,
            x: (s * 7 + 2) % n,
            y: (s * 3 + 19) % n,
            player,
            verb: VERB_RAISE,
            face,
            modifier: 1,
        }),
        120 => buf.push(Command {
            tick,
            x: (s * 11) % n,
            y: (s * 13) % n,
            player,
            verb: VERB_MAGNET,
            face,
            modifier: 0,
        }),
        160 => buf.push(Command {
            tick,
            x: (s * 17) % n,
            y: (s * 19) % n,
            player,
            verb: VERB_VOLCANO,
            face,
            modifier: 0,
        }),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_demo_script_exercises_every_verb_it_claims_to() {
        let mut seen = std::collections::BTreeSet::new();
        for tick in 0..2000 {
            let mut buf = CommandBuf::new();
            demo_script(tick, &mut buf);
            for c in buf.as_slice() {
                seen.insert(c.verb);
            }
        }
        for verb in [VERB_RAISE, VERB_LOWER, VERB_MAGNET, VERB_VOLCANO] {
            assert!(seen.contains(&verb), "verb {verb} never appears in the script");
        }
    }

    #[test]
    fn the_demo_script_depends_only_on_the_tick() {
        for tick in [0u32, 7, 199, 4001] {
            let mut a = CommandBuf::new();
            let mut b = CommandBuf::new();
            demo_script(tick, &mut a);
            demo_script(tick, &mut b);
            assert_eq!(a.as_slice(), b.as_slice());
        }
    }

    #[test]
    fn hash_line_parsing_roundtrips() {
        let src = "# comment\n0 0x0123456789abcdef\n30 0xfedcba9876543210\n";
        let got = parse_hashes(src).expect("parse");
        assert_eq!(got, std::vec![(0, 0x0123_4567_89ab_cdef), (30, 0xfedc_ba98_7654_3210)]);
        assert!(parse_hashes("nope\n").is_err());
    }

    #[test]
    fn a_recorded_log_replays_to_the_hashes_recorded_with_it() {
        // The `record` -> `replay --verify` loop, without touching the filesystem.
        let mut log = String::new();
        let _ = writeln!(log, "seed 99\nn {N}\nterrain 1\nticks 400");
        for tick in 0..400u32 {
            let mut buf = CommandBuf::new();
            demo_script(tick, &mut buf);
            for c in buf.as_slice() {
                let _ = writeln!(
                    log,
                    "c {} {} {} {} {} {} {}",
                    c.tick, c.player, c.verb, c.face, c.x, c.y, c.modifier
                );
            }
        }
        let (_, a) = powers::replay(&log).expect("replay");
        let (_, b) = powers::replay(&log).expect("replay");
        assert_eq!(a, b);
        assert!(a.len() > 10);
    }

    #[test]
    fn opts_parse_hex_and_named_terrain() {
        let args: Vec<String> =
            ["--seed", "0xBEEF", "--ticks", "12", "--terrain", "volcano", "--verify", "file.log"]
                .iter()
                .map(|s| (*s).to_string())
                .collect();
        let o = Opts::parse(&args);
        assert_eq!(o.seed, 0xBEEF);
        assert_eq!(o.ticks, 12);
        assert_eq!(o.terrain, TERRAIN_VOLCANO);
        assert!(o.verify);
        assert_eq!(o.positional, std::vec!["file.log".to_string()]);
    }
}
