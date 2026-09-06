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
    Command, CommandBuf, MapConfig, N, POWER_COUNT, TERRAIN_ARCHIPELAGO, TERRAIN_PANGAEA,
    TERRAIN_VOLCANO, VERB_ARMAGEDDON, VERB_CHAMPION, VERB_EARTHQUAKE, VERB_FLOOD, VERB_LOWER,
    VERB_MAGNET, VERB_RAISE, VERB_SET_HAND, VERB_SWAMP, VERB_VOLCANO, World,
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
  diomano-cli corpus  [--dir fixtures] [--matches N] [--ticks N] [--check-only]\n  diomano-cli trace   [--seed N] [--ticks N] [--every N]
  diomano-cli census  <file>

TERRAIN: archipelago | pangaea | volcano
";

/// Ticks per corpus match. §6.3 asks for at least 20,000.
const CORPUS_TICKS: u32 = 20_000;

/// Matches in the corpus. §6.3 asks for 10.
const CORPUS_MATCHES: u32 = 10;

/// §6.3: every verb at least this many times.
const MIN_VERB_USES: u32 = 20;

/// §6.3: at least this many combat resolutions.
const MIN_COMBAT_RESOLUTIONS: u32 = 200;

/// Every verb a player can issue. `VERB_NOP` is not one of them.
const ALL_VERBS: [u8; 10] = [
    VERB_RAISE,
    VERB_LOWER,
    VERB_MAGNET,
    VERB_EARTHQUAKE,
    VERB_SWAMP,
    VERB_VOLCANO,
    VERB_FLOOD,
    VERB_CHAMPION,
    VERB_ARMAGEDDON,
    VERB_SET_HAND,
];

/// All eight powers enabled.
///
/// The corpus runs with this rather than the shipped §5.4 manifest, which
/// disables swamp — on the shipped mask `VERB_SWAMP` is inert, and §6.3's "every
/// verb at least 20 times" is then unreachable no matter how long the match runs.
/// Coverage of the *disabled* path is not lost: `fixtures/session.log` is still
/// recorded on the shipped manifest, so both sides of the gate are exercised, by
/// different artifacts, on purpose.
const CORPUS_POWERS: u32 = (1 << POWER_COUNT) - 1;

fn verb_name(verb: u8) -> &'static str {
    match verb {
        VERB_RAISE => "raise",
        VERB_LOWER => "lower",
        VERB_MAGNET => "magnet",
        VERB_EARTHQUAKE => "earthquake",
        VERB_SWAMP => "swamp",
        VERB_VOLCANO => "volcano",
        VERB_FLOOD => "flood",
        VERB_CHAMPION => "champion",
        VERB_ARMAGEDDON => "armageddon",
        VERB_SET_HAND => "set-hand",
        _ => "?",
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        eprint!("{USAGE}");
        return ExitCode::FAILURE;
    };
    let opts = match Opts::parse(&args[1..]) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let result = match cmd {
        "version" => {
            println!("diomano-cli {VERSION} (sim {VERSION}, N = {N}, {TICK_HZ} Hz)");
            Ok(())
        }
        "hash" => cmd_hash(&opts),
        "perf" => cmd_perf(&opts),
        "replay" => cmd_replay(&opts),
        "record" => cmd_record(&opts),
        "corpus" => cmd_corpus(&opts),
        "census" => cmd_census(&opts),
        "trace" => cmd_trace(&opts),
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
    dir: PathBuf,
    matches: u32,
    /// Enabled-power bitmask written into a recorded log's header.
    powers: u32,
    /// Write `free_powers 1` into a recorded log, zeroing every power's cost.
    free_powers: bool,
    /// Enable the scripted opponent.
    ai: bool,
    /// Issue the world-ending verbs (flood, armageddon). See `CATACLYSM_FROM`.
    cataclysm: bool,
    /// `corpus`: verify what is on disk instead of regenerating it.
    check_only: bool,
}

impl Opts {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut o = Self {
            positional: Vec::new(),
            seed: 0x5EED,
            ticks: 3_000,
            every: 30,
            terrain: TERRAIN_ARCHIPELAGO,
            verify: false,
            out: PathBuf::from("fixtures/session.log"),
            hashes_out: PathBuf::from("fixtures/session.hashes"),
            dir: PathBuf::from("fixtures"),
            matches: CORPUS_MATCHES,
            // The shipped §5.4 mask, so `record` keeps producing a fixture on the
            // manifest the game actually ships with.
            powers: shipped_powers_mask(),
            free_powers: false,
            ai: false,
            cataclysm: true,
            check_only: false,
        };
        let mut i = 0;
        while i < args.len() {
            let a = args[i].as_str();
            // Every option that takes an operand fails without one. `--ticks` at
            // the end of the line used to read as zero ticks, and `record` then
            // wrote an empty fixture that `replay --verify` was happy with.
            let mut value = || -> Result<String, String> {
                i += 1;
                args.get(i).cloned().ok_or_else(|| format!("`{a}` needs a value\n\n{USAGE}"))
            };
            match a {
                "--seed" => o.seed = parse_u32(a, &value()?)?,
                "--ticks" => o.ticks = parse_u32(a, &value()?)?,
                "--every" => o.every = parse_u32(a, &value()?)?.max(1),
                "--out" => o.out = PathBuf::from(value()?),
                "--hashes" => o.hashes_out = PathBuf::from(value()?),
                "--terrain" => {
                    let name = value()?;
                    o.terrain = match name.as_str() {
                        "archipelago" => TERRAIN_ARCHIPELAGO,
                        "pangaea" => TERRAIN_PANGAEA,
                        "volcano" => TERRAIN_VOLCANO,
                        _ => return Err(format!("unknown terrain `{name}`\n\n{USAGE}")),
                    };
                }
                "--verify" => o.verify = true,
                "--dir" => o.dir = PathBuf::from(value()?),
                "--matches" => o.matches = parse_u32(a, &value()?)?.max(1),
                "--powers" => o.powers = parse_u32(a, &value()?)?,
                "--free-powers" => o.free_powers = true,
                "--ai" => o.ai = true,
                "--no-cataclysm" => o.cataclysm = false,
                "--check-only" => o.check_only = true,
                // An unknown option is a typo, not a file name: `--tick 600` used
                // to become a positional argument and run with the defaults.
                other if other.starts_with("--") => {
                    return Err(format!("unknown option `{other}`\n\n{USAGE}"));
                }
                other => o.positional.push(other.to_string()),
            }
            i += 1;
        }
        Ok(o)
    }

    fn config(&self) -> MapConfig {
        let mut cfg = MapConfig::DEFAULT;
        cfg.seed = self.seed;
        cfg.terrain = self.terrain;
        cfg
    }
}

/// The enabled-power bitmask of the shipped §5.4 manifest, read off
/// `MapConfig::DEFAULT` rather than written out, so the two cannot drift.
fn shipped_powers_mask() -> u32 {
    let mut mask = 0u32;
    for (p, &on) in MapConfig::DEFAULT.power_enabled.iter().enumerate() {
        if on != 0 {
            mask |= 1 << p;
        }
    }
    mask
}

/// Decimal or `0x`-prefixed hex. Anything else is an error, not zero: `--seed
/// 5EED` (no prefix) used to run seed 0 without a word.
fn parse_u32(flag: &str, s: &str) -> Result<u32, String> {
    let s = s.trim();
    let parsed = if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u32::from_str_radix(hex, 16)
    } else {
        s.parse()
    };
    parsed.map_err(|e| format!("`{flag}` wants an integer, got `{s}`: {e}"))
}

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

/// Tick a world from a seed and print a hash every `--every` ticks.
///
/// The correctness instrument for everything else: two runs, `diff`, done. The
/// printed value is `last_hash`, the hash `World::tick` takes every 30 ticks with
/// the counter still at `tick` — the same value `replay` prints and the fixtures
/// store, so those outputs diff line for line against this one. Hashing here
/// after `tick()` returned would hash a counter of `tick + 1` and agree with
/// nothing, and at a cadence that is not a multiple of 30 `last_hash` would be
/// stale, so that cadence is refused.
fn cmd_hash(o: &Opts) -> Result<(), String> {
    if !o.every.is_multiple_of(30) {
        return Err(format!("--every must be a multiple of 30, the hash cadence; got {}", o.every));
    }
    let mut w = World::boxed();
    w.init(&o.config());
    println!("# diomano hash seed={:#x} n={N} terrain={} ticks={}", o.seed, o.terrain, o.ticks);
    for tick in 0..o.ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, o.seed, o.cataclysm, true, &mut buf);
        w.tick(buf.as_slice());
        if tick % o.every == 0 {
            println!("{tick} {:#018x}", w.last_hash);
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
    // A second world driven through `World::tick` with the same input, compared
    // against the hand-sequenced one at the end: the sequence below is a copy of
    // the tick, and this is what keeps the copy honest.
    let mut reference = World::boxed();
    reference.init(&o.config());

    const PASSES: usize = 13;
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
        "8a pickups",
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
        reference.tick(&[]);
    }

    let smooth_runs_before = mesh.smooth_runs;
    let wall = Instant::now();
    for tick in 0..ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, o.seed, o.cataclysm, true, &mut buf);

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
        powers::pickups_step(&mut w);
        lap(9, &mut t, &mut total);
        combat::resolve(&mut w);
        lap(10, &mut t, &mut total);
        settlements::update(&mut w);
        lap(11, &mut t, &mut total);
        if w.tick.is_multiple_of(15) {
            flowfield::rebuild(&mut w);
            flowfield::project(&mut w);
        }
        lap(12, &mut t, &mut total);
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

    // Same input through the real tick. A different state means the pass
    // sequence above has drifted from `World::tick` and the timings measure a
    // different simulation.
    for tick in 0..ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, o.seed, o.cataclysm, true, &mut buf);
        reference.tick(buf.as_slice());
    }
    if w.state_hash() != reference.state_hash() {
        return Err(
            "the perf harness's pass sequence no longer matches World::tick (state hashes differ)"
                .to_string(),
        );
    }

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
        "{:<28} {:>10.4}   ({:.1} chunks/tick, smoothing ran on {} of {ticks} ticks)",
        "meshing (render budget)",
        ms(extra_mesh),
        chunks_remeshed as f64 / f,
        mesh.smooth_runs.saturating_sub(smooth_runs_before)
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

    // Two empty lists compare equal, and a log that declares zero ticks produces
    // exactly that — `record --ticks` with the operand missing used to write one.
    if hashes.is_empty() {
        return Err(format!("{path} declares no ticks, so the replay produced nothing to verify"));
    }
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
    let log = write_log(&LogSpec {
        seed: o.seed,
        terrain: o.terrain,
        powers: o.powers,
        free_powers: o.free_powers,
        cataclysm: o.cataclysm,
        ticks: o.ticks,
        ai: o.ai,
        endless: false,
        land_bridge: false,
        tide: TideSpec::shipped(),
    });
    let (w, hashes) = powers::replay(&log).map_err(|e| format!("line {}: {}", e.line, e.what))?;
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
        "wrote {} ({} bytes) and {} ({} hashes over {} ticks)",
        o.out.display(),
        log.len(),
        o.hashes_out.display(),
        hashes.len(),
        o.ticks
    );
    print_census(&w);
    Ok(())
}

/// The earliest tick a match may legitimately be decided at.
///
/// 1,275 was the first wave peak under the old 45-second cadence, and it stays
/// the right *absolute* floor now that the tide is minutes away: a match
/// decided inside forty seconds is a spawn that dissolved, not a war that was
/// lost.
const MIN_MATCH_TICKS: u32 = 1_275;

/// Everything a session log's header states about the match it drives.
struct LogSpec {
    seed: u32,
    terrain: u8,
    powers: u32,
    free_powers: bool,
    cataclysm: bool,
    ticks: u32,
    ai: bool,
    endless: bool,
    /// Carve the corridor between the two spawns. Corpus logs only.
    land_bridge: bool,
    /// The tide the log replays under. See `TideSpec`.
    tide: TideSpec,
}

/// The tide cycle a log states for itself.
///
/// Written into the header so a fixture does not silently depend on
/// `MapConfig::DEFAULT`: it used to, and retuning the shipped cadence therefore
/// invalidated ten corpus matches that had nothing to do with the tide.
#[derive(Clone, Copy)]
struct TideSpec {
    waves: u8,
    telegraph: u32,
    impact: u32,
    recovery: u32,
    lull: u32,
    escalation: u16,
    strength: i16,
}

impl TideSpec {
    /// The shipped cadence: a wave every fifteen minutes, three of them.
    fn shipped() -> Self {
        let cfg = MapConfig::DEFAULT;
        Self {
            waves: cfg.waves,
            telegraph: cfg.telegraph_ticks,
            impact: cfg.impact_ticks,
            recovery: cfg.recovery_ticks,
            lull: cfg.lull_ticks,
            escalation: cfg.escalation,
            strength: cfg.wave_strength,
        }
    }

    /// A deliberately fast tide, for the §6.3 corpus.
    ///
    /// A corpus match is 20,000 ticks and the shipped cadence puts one wave
    /// every 27,000, so on the shipped numbers every one of the ten matches
    /// would spend its whole life in the opening lull and the corpus would
    /// cover the telegraph, the impact and the recovery exactly zero times.
    /// Determinism is what the corpus tests; the cadence is a balance number.
    /// So the corpus states its own, and states it in the log.
    fn corpus() -> Self {
        Self { waves: 7, telegraph: 300, impact: 150, recovery: 900, lull: 900, ..Self::shipped() }
    }
}

/// Render a session log: header lines, then one line per command.
fn write_log(spec: &LogSpec) -> String {
    let mut log = String::new();
    let _ = writeln!(log, "# diomano session log v1 — generated by `diomano-cli`");
    let _ = writeln!(log, "# commands: c <tick> <player> <verb> <face> <x> <y> <modifier>");
    let _ = writeln!(log, "seed {}", spec.seed);
    let _ = writeln!(log, "n {N}");
    let _ = writeln!(log, "terrain {}", spec.terrain);
    let _ = writeln!(log, "powers {}", spec.powers);
    let _ = writeln!(log, "free_powers {}", u8::from(spec.free_powers));
    // Always explicit, never inherited from `MapConfig::DEFAULT`: a log that
    // omitted `ai` would silently grow an opponent if the default ever flipped.
    let _ = writeln!(log, "ai {}", u8::from(spec.ai));
    let _ = writeln!(log, "endless {}", u8::from(spec.endless));
    let _ = writeln!(log, "land_bridge {}", u8::from(spec.land_bridge));
    let _ = writeln!(log, "waves {}", spec.tide.waves);
    let _ = writeln!(log, "telegraph_ticks {}", spec.tide.telegraph);
    let _ = writeln!(log, "impact_ticks {}", spec.tide.impact);
    let _ = writeln!(log, "recovery_ticks {}", spec.tide.recovery);
    let _ = writeln!(log, "lull_ticks {}", spec.tide.lull);
    let _ = writeln!(log, "escalation {}", spec.tide.escalation);
    let _ = writeln!(log, "strength {}", spec.tide.strength);
    let _ = writeln!(
        log,
        "# profile: {}",
        if spec.ai {
            "ai-war"
        } else if spec.cataclysm {
            "cataclysm"
        } else {
            "war"
        }
    );
    let _ = writeln!(log, "ticks {}", spec.ticks);
    for tick in 0..spec.ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, spec.seed, spec.cataclysm, !spec.ai, &mut buf);
        for c in buf.as_slice() {
            let _ = writeln!(
                log,
                "c {} {} {} {} {} {} {}",
                c.tick, c.player, c.verb, c.face, c.x, c.y, c.modifier
            );
        }
    }
    log
}

// ---------------------------------------------------------------------------
// census
// ---------------------------------------------------------------------------

fn print_census(w: &World) {
    let census = &w.census;
    println!(
        "  census: {} combat resolutions, {} merges",
        census.combat_resolutions, census.merges
    );
    println!(
        "  end state: walkers {:?}, settlements {}, mana {:?}",
        w.walker_count,
        w.settlement_count,
        [w.mana[0] >> 16, w.mana[1] >> 16]
    );
    print!("  applied:");
    for verb in ALL_VERBS {
        print!(" {}={}", verb_name(verb), census.verb_applied[verb as usize]);
    }
    println!();
}

/// Walk a scripted match and print the economy every `--every` ticks.
///
/// Exists because the census only reports the end state, and "no combat happened"
/// has several possible causes — no walkers, no settlements, unreachable rally
/// point, an empty hand that makes every raise a no-op. This tells you which.
fn cmd_trace(o: &Opts) -> Result<(), String> {
    let mut cfg = o.config();
    cfg.ai_enabled = u8::from(o.ai);
    cfg.power_cost = [0; POWER_COUNT];
    for p in 0..POWER_COUNT {
        cfg.power_enabled[p] = 1;
    }
    let mut w = World::boxed();
    w.init(&cfg);
    // An outcome before this means a spawn dissolved with no war fought — the
    // instant-defeat failure mode, worth a non-zero exit even from a diagnostic
    // tool. The deliberate `--cataclysm` armageddon is exempt: ending early is
    // its job.
    //
    // An absolute floor rather than the first wave peak, which is what it used
    // to be. At the shipped cadence the first wave lands at tick 3,900, and the
    // scripted opponent can legitimately win by siege against a player who
    // never acts well before then (§5.5 sudden death, and the playtest note in
    // PLAN.md). Tying the floor to the tide would fail that legitimate match
    // and pass an instant defeat on any map with a slow enough tide, which is
    // exactly backwards.
    let earliest_honest_decision = MIN_MATCH_TICKS;
    let mut decided_at: Option<u32> = None;
    println!("tick  walkers  settle  tiers      hand0  mana0  sea  combat  merges");
    for tick in 0..o.ticks {
        let mut buf = CommandBuf::new();
        demo_script(tick, o.seed, o.cataclysm, !o.ai, &mut buf);
        w.tick(buf.as_slice());
        if w.outcome != 0 && decided_at.is_none() {
            decided_at = Some(tick);
        }
        if tick % o.every == 0 {
            let mut tiers = [0u32; 5];
            for s in &w.settlements {
                if s.alive() {
                    tiers[(s.tier as usize).min(4)] += 1;
                }
            }
            let pos: Vec<String> = w
                .walkers
                .iter()
                .filter(|k| k.alive())
                .map(|k| {
                    let c = diomano_sim::world::idx(
                        k.face as usize,
                        (k.x >> 16).clamp(0, N as i32 - 1) as usize,
                        (k.y >> 16).clamp(0, N as i32 - 1) as usize,
                    );
                    let field =
                        if k.flags & 4 != 0 { 1 - (k.owner as usize) } else { k.owner as usize };
                    format!(
                        "p{} f{} {},{} s{}{} flow={} dist={:#x}",
                        k.owner,
                        k.face,
                        k.x >> 16,
                        k.y >> 16,
                        k.strength,
                        if k.flags & 4 != 0 { " CH" } else { "" },
                        w.flow[field][c],
                        w.dist[field][c],
                    )
                })
                .collect();
            println!("      walkers: {}", pos.join(" | "));
            let magnets: Vec<String> = (0..2)
                .map(|p| {
                    let m = &w.magnet[p];
                    if m.active != 0 {
                        format!("p{p} f{} {},{} leader={}", m.face, m.x, m.y, m.leader)
                    } else {
                        format!("p{p} off")
                    }
                })
                .collect();
            println!(
                "      magnets: {} | ai phase {} | outcome {}",
                magnets.join(" | "),
                w.ai.phase,
                w.outcome
            );
            println!(
                "{tick:<6}{:?}  {:<6}  {tiers:?}  {:<6} {:<6} {:<4} {:<7} {}",
                w.walker_count,
                w.settlement_count,
                w.hand[0].amount,
                w.mana[0] >> 16,
                w.sea_level,
                w.census.combat_resolutions,
                w.census.merges
            );
        }
    }
    if let Some(t) = decided_at
        && !o.cataclysm
        && u64::from(t) < u64::from(earliest_honest_decision)
    {
        return Err(format!(
            "match decided at tick {t}, inside the first {earliest_honest_decision} ticks — a spawn dissolved with no war fought"
        ));
    }
    Ok(())
}

/// What did this log actually exercise? Replays it and prints the census.
fn cmd_census(o: &Opts) -> Result<(), String> {
    let path = o.positional.first().ok_or("census needs a log file")?;
    let src = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let (w, hashes) = powers::replay(&src).map_err(|e| format!("line {}: {}", e.line, e.what))?;
    println!("{path}: {} hashes", hashes.len());
    print_census(&w);
    Ok(())
}

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

/// Verbs a `war`-profile match deliberately does not issue. See [`CATACLYSM_FROM`].
///
/// Read only by the test that pins the two profiles apart; the script itself gates
/// them by name. Kept here rather than in the test module because it documents a
/// property of the corpus, not of the test.
#[cfg_attr(not(test), allow(dead_code, reason = "only the profile test reads it"))]
const CATACLYSM_VERBS: [u8; 2] = [VERB_FLOOD, VERB_ARMAGEDDON];

/// First match index that runs the `cataclysm` profile; earlier ones run `war`.
///
/// The corpus is split because §6.3's two coverage demands fight each other inside
/// a single match, and the reason is `VERB_FLOOD`: it raises `sea_base` and
/// *nothing lowers it again*. Twenty floods — the minimum §6.3 asks for — leave
/// the planet under water, which drowns the routes between the two faces, which
/// means no walker reaches the other side and combat resolutions stay at zero.
/// Armageddon is the same argument with the volume turned up.
///
/// So half the corpus plays a war that stays habitable, and half plays the
/// cataclysm; §6.3's counts are then met across the corpus rather than by every
/// match individually. Recorded here as a reading of the criterion, not a
/// weakening of it: ten long matches still cover every verb at least twenty times
/// and still produce the combat, and the per-match numbers are all printed so
/// nothing hides behind the total.
const CATACLYSM_FROM: u32 = 5;

/// First match index that runs with the scripted opponent enabled: the log
/// drives player 0 only and `ai.rs` — both its tutorial and its war phase —
/// owns player 1, so the opponent's whole behaviour gets long cross-build
/// determinism coverage. These run the `war` profile: an opponent whose
/// economy the log floods away would demonstrate nothing.
const AI_FROM: u32 = 8;

/// Sum of two censuses, for corpus-wide coverage.
fn add_census(acc: &mut diomano_sim::world::Census, c: &diomano_sim::world::Census) {
    acc.combat_resolutions = acc.combat_resolutions.saturating_add(c.combat_resolutions);
    acc.merges = acc.merges.saturating_add(c.merges);
    for (a, b) in acc.verb_applied.iter_mut().zip(c.verb_applied.iter()) {
        *a = a.saturating_add(*b);
    }
}

/// Every way `census` falls short of §6.3, rather than the first, so one run tells
/// you the whole story instead of one round of it.
fn coverage_shortfalls(census: &diomano_sim::world::Census) -> Vec<String> {
    let mut bad = Vec::new();
    if census.combat_resolutions < MIN_COMBAT_RESOLUTIONS {
        bad.push(format!(
            "{} combat resolutions, §6.3 wants at least {MIN_COMBAT_RESOLUTIONS}",
            census.combat_resolutions
        ));
    }
    for verb in ALL_VERBS {
        let n = census.verb_applied[verb as usize];
        if n < MIN_VERB_USES {
            bad.push(format!(
                "verb `{}` applied {n} times, wants {MIN_VERB_USES}",
                verb_name(verb)
            ));
        }
    }
    bad
}

/// Record — or with `--check-only`, verify — the §6.3 fixture corpus.
///
/// Ten matches of at least 20,000 ticks, covering every verb at least 20 times
/// with at least 200 combat resolutions. Deliberately a separate artifact from
/// `fixtures/session.log`: the corpus is long and slow and runs in its own CI job,
/// while `session.log` stays short enough to live inside `cargo test`, and is
/// recorded on the shipped §5.4 manifest so the power-gating path stays covered.
///
/// Coverage is asserted here rather than eyeballed, so a script change that quietly
/// stops issuing a verb fails the build instead of shrinking the corpus in silence.
fn cmd_corpus(o: &Opts) -> Result<(), String> {
    let ticks = if o.ticks == 3_000 { CORPUS_TICKS } else { o.ticks };
    std::fs::create_dir_all(&o.dir).map_err(|e| e.to_string())?;

    let mut total = diomano_sim::world::Census::ZEROED;
    let mut short_matches = Vec::new();

    for m in 0..o.matches {
        // Seed and profile both derive from the match index, so the corpus is
        // reproducible from nothing but this command.
        let seed = 0x5EED_0000u32.wrapping_add(m.wrapping_mul(0x9E37_79B9));
        let ai = m >= AI_FROM;
        let cataclysm = m >= CATACLYSM_FROM && !ai;
        let terrain = match m % 3 {
            0 => TERRAIN_ARCHIPELAGO,
            1 => TERRAIN_PANGAEA,
            _ => TERRAIN_VOLCANO,
        };
        let log_path = o.dir.join(format!("match-{m:02}.log"));
        let hash_path = o.dir.join(format!("match-{m:02}.hashes"));

        let log = if o.check_only {
            std::fs::read_to_string(&log_path)
                .map_err(|e| format!("cannot read {}: {e}", log_path.display()))?
        } else {
            write_log(&LogSpec {
                seed,
                terrain,
                powers: CORPUS_POWERS,
                free_powers: true,
                cataclysm,
                ticks,
                ai,
                endless: true,
                // The corpus needs the two armies to meet; see
                // `MapConfig::land_bridge`.
                land_bridge: true,
                tide: TideSpec::corpus(),
            })
        };

        let (w, hashes) =
            powers::replay(&log).map_err(|e| format!("line {}: {}", e.line, e.what))?;

        if o.check_only {
            let want = std::fs::read_to_string(&hash_path)
                .map_err(|e| format!("cannot read {}: {e}", hash_path.display()))?;
            let want = parse_hashes(&want)?;
            if want != hashes {
                return Err(format!("{} does not replay to its hashes", log_path.display()));
            }
        } else {
            let mut out = String::new();
            let _ = writeln!(out, "# state hashes for match-{m:02}.log, one per 30 ticks");
            for (tick, h) in &hashes {
                let _ = writeln!(out, "{tick} {h:#018x}");
            }
            std::fs::write(&log_path, &log).map_err(|e| e.to_string())?;
            std::fs::write(&hash_path, &out).map_err(|e| e.to_string())?;
        }

        let header = powers::parse_log_header(&log).map_err(|e| e.what.to_string())?;
        println!(
            "match-{m:02}: {} — seed {seed:#010x} terrain {terrain}, {} ticks, {} hashes",
            if ai {
                "ai-war   "
            } else if cataclysm {
                "cataclysm"
            } else {
                "war      "
            },
            header.ticks,
            hashes.len()
        );
        print_census(&w);

        // Tick count is per match; §6.3 is explicit that each match is long.
        if header.ticks < CORPUS_TICKS {
            short_matches
                .push(format!("match-{m:02}: {} ticks, wants {CORPUS_TICKS}", header.ticks));
        }
        add_census(&mut total, &w.census);
    }

    println!("\ncorpus totals over {} matches:", o.matches);
    print!(
        "  combat resolutions {}, merges {}\n  applied:",
        total.combat_resolutions, total.merges
    );
    for verb in ALL_VERBS {
        print!(" {}={}", verb_name(verb), total.verb_applied[verb as usize]);
    }
    println!();

    // Every §6.3 criterion is enforced, the combat count included. It was a
    // KNOWN GAP for as long as the two spawns had no land route between them;
    // the contact corridor (settlements.rs) closed it — the corpus now records
    // thousands of resolutions, so a drop below 200 is a regression, not a
    // known condition.
    let mut failures = short_matches;
    failures.extend(coverage_shortfalls(&total));

    if failures.is_empty() {
        println!(
            "\ncorpus OK — {} matches of {CORPUS_TICKS}+ ticks, every verb {MIN_VERB_USES}+, \
             {MIN_COMBAT_RESOLUTIONS}+ combat resolutions",
            o.matches,
        );
        Ok(())
    } else {
        Err(format!("corpus does not meet §6.3:\n  {}", failures.join("\n  ")))
    }
}

// ---------------------------------------------------------------------------
// The scripted session
// ---------------------------------------------------------------------------

/// A deterministic input script covering every verb the CLI can reach.
///
/// Shared by `hash`, `perf` and `record` so that a fixture, a timing run and a
/// determinism check all exercise the same code paths. Depends on the tick
/// number and the seed and nothing else — a script that read the world would
/// make the log meaningless, because the log is supposed to be the *input*.
///
/// # Why the seed only moves things sideways
///
/// The seed perturbs *where* each command lands, never *when*. So every match in
/// the §6.3 corpus issues the same verbs the same number of times while touching
/// different terrain, which is what makes ten matches ten samples of the same
/// coverage rather than ten different amounts of it.
///
/// # The 400-tick cycle
///
/// One pass of the cycle issues every verb at least once, so a 20,000-tick match
/// gets 50 cycles and clears §6.3's "at least 20 times" for all of them with
/// room to spare. Armageddon is the exception, on an 800-tick period: it is the
/// most destructive verb in the game and firing it every 400 ticks flattens the
/// world faster than settlements can rebuild, which starves the very combat the
/// corpus also has to cover.
/// `(s * k + b) mod N`, computed in `u32` and only then narrowed.
///
/// The multiply used to happen in `u16`, which is fine for 2,400 ticks and
/// panics at 20,000: `s` reaches 4,000 and `s * 53` leaves the type. Overflow
/// checks are on in every profile (§10), so extending the corpus turned that from
/// a latent silent wrap into a crash — which is the lint set doing its job.
fn coord(s: u32, k: u32, b: u32) -> u16 {
    (s.wrapping_mul(k).wrapping_add(b) % N as u32) as u16
}

fn demo_script(tick: u32, seed: u32, cataclysm: bool, two_sided: bool, buf: &mut CommandBuf) {
    // Seed salt. Only ever mixed into coordinates and faces, never into the
    // schedule.
    let salt = seed.wrapping_mul(2_654_435_761);
    let cycle = tick / 400;
    let phase = tick % 400;

    // Two fixed home bases, one per player, on opposite faces. Fixed on purpose:
    // the raise window flattens the *same* ground every cycle, which is what
    // actually produces a plateau and therefore a settlement, a population and
    // walkers. Scattering raises across the planet — which is what this script
    // used to do — leaves a noisy heightfield, no plateau anywhere, one settlement
    // per side and an economy that never starts.
    let (hface, hx, hy) = home(0);
    let (eface, ex, ey) = home(1);

    // Whose home everybody rallies at, rotating in SIX-cycle windows: the
    // causeway midpoint, then each home in turn. Sending both magnets to the
    // same cell is the only way a script can cause combat: §4.7 contact is
    // autonomous (pillar 3), so the log can arrange the geometry and nothing
    // else. The window length is the load-bearing number: walkers cross at
    // ONE/16 cells per tick, so the midpoint is ~1,000 ticks from either spawn
    // and the far home ~2,000 — a rally that rotates every 400-tick cycle is a
    // yo-yo nobody ever reaches. Measured: 20,000 ticks, zero combat. At 2,400
    // ticks per window both armies actually arrive, collide mid-road, and
    // besiege each other's homes.
    let (rface, rx, ry) = match (cycle / 6) % 3 {
        0 => causeway_rally(),
        1 => (hface, hx, hy),
        _ => (eface, ex, ey),
    };

    // Player 0 works its own ground on even cycles, player 1 on odd ones — or
    // player 0 alone when the scripted opponent owns the other side: the AI
    // emits its own commands inside the tick, and a log that also moved its
    // magnet would fight it for the same army.
    let player = if two_sided { (cycle % 2) as u8 } else { 0 };
    let (wface, wx, wy) = if player == 0 { (hface, hx, hy) } else { (eface, ex, ey) };

    match phase {
        // Dig, to fill the hand. `deform` will not let an empty hand build, so the
        // lower window is what pays for the raise window. Kept well away from the
        // home plateau, or it would undo the building.
        5..=40 => {
            let k = phase - 5;
            buf.push(Command {
                tick,
                x: coord(wx.into(), 1, 20 + k % 6),
                y: coord(wy.into(), 1, 20 + k / 6),
                player,
                verb: VERB_LOWER,
                face: wface,
                modifier: u8::from(tick.is_multiple_of(4)),
            });
        }
        // Build: a 7x7 block *beside* the player's home, one cell per tick, so the
        // same footprint is flattened over and over until it is a plateau.
        //
        // Offset off the settlement rather than centred on it. The starting
        // settlement is a 5x5 footprint at the home cell, and raising ground under
        // a settlement breaks the plateau it stands on — the script was demolishing
        // its own economy every cycle, and both sides ended a 6,000-tick match with
        // zero settlements.
        //
        // Anchored rather than centred deliberately. Centring means negative
        // offsets, and these are `u32` — `(k % 7) - 3` wraps to about four billion,
        // `coord` reduces that mod N, and the "block" lands as scatter across the
        // face. Which is what this script did before, and why no plateau ever
        // formed: 46 raises per cycle, none of them on top of each other.
        50..=95 => {
            let k = phase - 50;
            buf.push(Command {
                tick,
                x: coord(wx.into(), 1, 6 + k % 7),
                y: coord(wy.into(), 1, 6 + k / 7),
                player,
                verb: VERB_RAISE,
                face: wface,
                modifier: 1,
            });
        }
        // Both magnets onto the rally cell, one tick apart.
        120 => buf.push(Command {
            tick,
            x: rx,
            y: ry,
            player: 0,
            verb: VERB_MAGNET,
            face: rface,
            modifier: 0,
        }),
        121 if two_sided => buf.push(Command {
            tick,
            x: rx,
            y: ry,
            player: 1,
            verb: VERB_MAGNET,
            face: rface,
            modifier: 0,
        }),
        // The destructive verbs, aimed away from both homes so that covering them
        // does not also flatten the economy that produces the walkers.
        160 => buf.push(Command {
            tick,
            x: coord(cycle, 17, 31),
            y: coord(cycle, 19, 31),
            player,
            verb: VERB_VOLCANO,
            face: wild_face(cycle, salt >> 5),
            modifier: 0,
        }),
        200 => buf.push(Command {
            tick,
            x: coord(cycle, 23, 29),
            y: coord(cycle, 29, 27),
            player,
            verb: VERB_EARTHQUAKE,
            face: wild_face(cycle, salt >> 7),
            modifier: u8::from(tick.is_multiple_of(800)),
        }),
        230 => buf.push(Command {
            tick,
            x: coord(cycle, 31, 25),
            y: coord(cycle, 37, 23),
            player,
            verb: VERB_SWAMP,
            face: wild_face(cycle, salt >> 9),
            modifier: 0,
        }),
        // Flood raises global sea level and damages both players (§5.2), so it is
        // on a slower period than the rest — often enough to clear §6.3's 20, rare
        // enough that the coastline still exists.
        260 if cataclysm && cycle.is_multiple_of(2) => buf.push(Command {
            tick,
            x: coord(cycle, 41, 0),
            y: coord(cycle, 43, 0),
            player,
            verb: VERB_FLOOD,
            face: wface,
            modifier: 0,
        }),
        // A champion each. They follow the *opponent's* flow field, which points at
        // the opponent's settlements — so champions are a second, independent way
        // this corpus reaches combat, one that does not depend on the rally point.
        290 => buf.push(Command {
            tick,
            x: rx,
            y: ry,
            player: 0,
            verb: VERB_CHAMPION,
            face: rface,
            modifier: 0,
        }),
        291 if two_sided => buf.push(Command {
            tick,
            x: rx,
            y: ry,
            player: 1,
            verb: VERB_CHAMPION,
            face: rface,
            modifier: 0,
        }),
        // Cycle the hand through earth, water and lava so `sculpt`'s three branches
        // all get used. Weighted to earth: water and lava in the hand build water
        // and lava, and a home plateau made of lava is not a home.
        310 => buf.push(Command {
            tick,
            x: if cycle.is_multiple_of(8) { (cycle / 8 % 2 + 1) as u16 } else { 0 },
            y: 0,
            player,
            verb: VERB_SET_HAND,
            face: wface,
            modifier: 0,
        }),
        // The most destructive verb in the game, on the slowest period that still
        // clears §6.3's 20 uses in a 20,000-tick match.
        350 if cataclysm && tick % 800 == 350 => buf.push(Command {
            tick,
            x: coord(cycle, 47, 0),
            y: coord(cycle, 53, 0),
            player,
            verb: VERB_ARMAGEDDON,
            face: wface,
            modifier: 0,
        }),
        _ => {}
    }
}

/// A player's home base: face, x, y.
///
/// Reads `settlements::STARTS` — the same compile-time constants
/// `seed_starting_positions` stamps, independent of seed and terrain. So a log —
/// which may not read the world — can still name ground that is certain to be
/// habitable and reachable.
///
/// That certainty is the whole game here. A salted rally point is a coin flip:
/// `step_walker` only follows its flow field and only onto `passable` ground, so a
/// rally point in the sea leaves the flow field with no route to it, every walker
/// stands still for the entire match, and the corpus records twenty thousand ticks
/// of nothing. Measured, before this was hardcoded: both walkers pinned at their
/// spawn cell from tick 0 to tick 3,000.
/// A face that is not either player's home.
///
/// The destructive verbs land here. Aiming them at faces 4 and 5 wrecks the two
/// starting settlements, and then there is no population, no walker and nothing to
/// fight with — the corpus needs these verbs *covered*, not aimed at the economy
/// it also has to exercise.
fn wild_face(cycle: u32, salt: u32) -> u8 {
    ((cycle >> 1).wrapping_add(salt) % 4) as u8
}

fn home(player: usize) -> (u8, u16, u16) {
    let (face, x, y) = diomano_sim::settlements::STARTS[player % 2];
    (face as u8, x as u16, y as u16)
}

/// The mid-causeway rally: the contact corridor's antipodal midpoint. A pure
/// function of nothing (see `settlements::corridor_cell`), so a log may name
/// it. Rallying both armies here collides them on the narrow contested road,
/// which is where the §6.3 combat coverage comes from.
fn causeway_rally() -> (u8, u16, u16) {
    let (face, x, y) =
        diomano_sim::settlements::corridor_cell(diomano_sim::settlements::CORRIDOR_STEPS / 2);
    (face, x.into(), y.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every verb, at least §6.3's 20 times, within one corpus match's length.
    #[test]
    fn the_demo_script_exercises_every_verb_it_claims_to() {
        let mut count = std::collections::BTreeMap::new();
        for tick in 0..CORPUS_TICKS {
            let mut buf = CommandBuf::new();
            demo_script(tick, 0x5EED, true, true, &mut buf);
            for c in buf.as_slice() {
                *count.entry(c.verb).or_insert(0u32) += 1;
            }
        }
        for verb in ALL_VERBS {
            let n = count.get(&verb).copied().unwrap_or(0);
            assert!(n >= 20, "verb {verb} appears {n} times in the script, §6.3 wants 20");
        }
    }

    #[test]
    fn the_demo_script_depends_only_on_the_tick_and_the_seed() {
        for tick in [0u32, 7, 199, 4001] {
            let mut a = CommandBuf::new();
            let mut b = CommandBuf::new();
            demo_script(tick, 0x5EED, true, true, &mut a);
            demo_script(tick, 0x5EED, true, true, &mut b);
            assert_eq!(a.as_slice(), b.as_slice());
        }
    }

    /// The two profiles must actually differ in the way `CATACLYSM_FROM` claims,
    /// or the corpus split is decoration and half of it covers nothing extra.
    #[test]
    fn the_war_profile_issues_no_world_ending_verbs() {
        let mut war = std::collections::BTreeSet::new();
        let mut cataclysm = std::collections::BTreeSet::new();
        for tick in 0..CORPUS_TICKS {
            let mut a = CommandBuf::new();
            let mut b = CommandBuf::new();
            demo_script(tick, 0x5EED, false, true, &mut a);
            demo_script(tick, 0x5EED, true, true, &mut b);
            for c in a.as_slice() {
                war.insert(c.verb);
            }
            for c in b.as_slice() {
                cataclysm.insert(c.verb);
            }
        }
        for verb in CATACLYSM_VERBS {
            assert!(!war.contains(&verb), "the war profile issued `{}`", verb_name(verb));
            assert!(
                cataclysm.contains(&verb),
                "the cataclysm profile never issued `{}`",
                verb_name(verb)
            );
        }
        // Everything else must be in both, or the war matches would cover less
        // than the corpus claims.
        for verb in ALL_VERBS {
            if CATACLYSM_VERBS.contains(&verb) {
                continue;
            }
            assert!(war.contains(&verb), "the war profile never issued `{}`", verb_name(verb));
        }
    }

    /// The seed must move commands sideways without changing which verbs are
    /// issued or when. Otherwise the ten corpus matches would each cover a
    /// different amount, and "10 matches covering every verb" would stop meaning
    /// anything.
    #[test]
    fn the_seed_moves_positions_but_not_the_schedule() {
        let mut differed = false;
        for tick in 0..CORPUS_TICKS.min(4_000) {
            let mut a = CommandBuf::new();
            let mut b = CommandBuf::new();
            demo_script(tick, 1, true, true, &mut a);
            demo_script(tick, 2, true, true, &mut b);
            let (a, b) = (a.as_slice(), b.as_slice());
            assert_eq!(a.len(), b.len(), "seed changed how many commands tick {tick} issues");
            for (ca, cb) in a.iter().zip(b.iter()) {
                assert_eq!(ca.verb, cb.verb, "seed changed the verb at tick {tick}");
                assert_eq!(ca.tick, cb.tick);
                assert_eq!(ca.player, cb.player, "seed changed the player at tick {tick}");
                if (ca.x, ca.y, ca.face) != (cb.x, cb.y, cb.face) {
                    differed = true;
                }
            }
        }
        assert!(differed, "the seed changed nothing at all — the corpus would be ten copies");
    }

    /// The rally rotation must include the causeway midpoint, and that point
    /// must be the corridor's own cell — otherwise the armies never collide
    /// mid-road and the corpus falls back to siege-only combat.
    #[test]
    fn the_rally_rotation_includes_the_causeway() {
        let mut rallies = std::collections::BTreeSet::new();
        // Three full six-cycle rally windows: 18 cycles of 400 ticks.
        for tick in 0..CORPUS_TICKS.min(7_300) {
            let mut buf = CommandBuf::new();
            demo_script(tick, 0x5EED, false, true, &mut buf);
            for c in buf.as_slice() {
                if c.verb == VERB_MAGNET {
                    rallies.insert((c.face, c.x, c.y));
                }
            }
        }
        let mid = causeway_rally();
        assert!(rallies.contains(&mid), "no magnet ever rallies on the causeway midpoint");
        assert!(rallies.contains(&home(0)), "no magnet ever rallies at home 0");
        assert!(rallies.contains(&home(1)), "no magnet ever rallies at home 1");
    }

    /// One-sided mode must silence player 1 without changing player 0's
    /// schedule — the scripted opponent owns that side.
    #[test]
    fn one_sided_scripts_never_move_the_opponents_pieces() {
        for tick in 0..CORPUS_TICKS.min(2_000) {
            let mut buf = CommandBuf::new();
            demo_script(tick, 0x5EED, false, false, &mut buf);
            for c in buf.as_slice() {
                assert_eq!(c.player, 0, "one-sided script moved player 1 at tick {tick}");
            }
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
            demo_script(tick, 99, true, true, &mut buf);
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
        let o = Opts::parse(&args).expect("a well-formed command line");
        assert_eq!(o.seed, 0xBEEF);
        assert_eq!(o.ticks, 12);
        assert_eq!(o.terrain, TERRAIN_VOLCANO);
        assert!(o.verify);
        assert_eq!(o.positional, std::vec!["file.log".to_string()]);
    }

    #[test]
    fn opts_refuse_what_they_cannot_honour() {
        let parse =
            |line: &[&str]| Opts::parse(&line.iter().map(|s| (*s).to_string()).collect::<Vec<_>>());
        assert!(parse(&["--ticks"]).is_err(), "a missing operand read as zero ticks");
        assert!(parse(&["--seed", "5EED"]).is_err(), "unprefixed hex read as seed 0");
        assert!(
            parse(&["--terrain", "moon"]).is_err(),
            "an unknown terrain fell back to archipelago"
        );
        assert!(parse(&["--tick", "12"]).is_err(), "a misspelt option became a file name");
        assert!(parse(&["fixtures/session.log"]).is_ok(), "a plain file name is positional");
    }
}
