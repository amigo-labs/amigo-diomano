//! Verbs, their costs, the map manifest and the session-log format.
//! HANDOFF §5.
//!
//! The map is the ruleset, not just geometry (§5.4). Everything here is pure
//! configuration applied to pure verbs: disabling a power in the manifest removes
//! it from the game with no code change, which is the Phase 6 DoD.
//!
//! The parsers are hand-written because the simulation crate takes no
//! dependencies and `serde` is explicitly out (§9.4). They accept a deliberately
//! small subset — enough for §5.4's manifest and for a replay log — and reject
//! everything else with a line number rather than guessing.

use crate::world::{
    Command, HAND_CAPACITY, HAND_EARTH, HAND_LAVA, HAND_WATER, HEIGHT_MAX, HEIGHT_MIN, MAT_ASH,
    MAT_SWAMP, MAX_PICKUPS, MapConfig, N, PICKUP_ALIVE, PLAYERS, POWER_COUNT, Pickup, TERRACE,
    TERRAIN_ARCHIPELAGO, TERRAIN_PANGAEA, TERRAIN_VOLCANO, VERB_ARMAGEDDON, VERB_CHAMPION,
    VERB_EARTHQUAKE, VERB_FLOOD, VERB_LOWER, VERB_MAGNET, VERB_RAISE, VERB_SET_HAND, VERB_SWAMP,
    VERB_VOLCANO, World, idx, verb_power, walk,
};

/// Highest `sea_base` the flood verb can reach: two terraces above the
/// starting sea. Enough to drown coastal flats on both sides — real strategic
/// pressure — while staying below the causeway band's lowest dry cell
/// (`settlements::CAUSEWAY_CREST_MIN - 2`), so flooding can never
/// *permanently* sever the contact corridor: a road only the tide may close,
/// and only temporarily. (At four terraces, two casts amputated the game's
/// one artery for good — traced, both armies parked for the rest of the
/// match.)
pub const FLOOD_CAP: i16 = 2 * TERRACE;

/// Apply one command.
///
/// Cost and availability are checked first and uniformly, so a power that is
/// disabled in the manifest is inert everywhere without a single call site
/// knowing about it.
pub fn apply(w: &mut World, player: usize, cmd: &Command) {
    let face = (cmd.face as usize) % 6;
    let cx = i32::from(cmd.x).clamp(0, N as i32 - 1);
    let cy = i32::from(cmd.y).clamp(0, N as i32 - 1);

    if let Some(power) = verb_power(cmd.verb) {
        if w.cfg.power_enabled[power] == 0 {
            return;
        }
        // A collected pickup pays for exactly one use, before mana is consulted
        // (§5.3 "free single-use powers"). Spending the charge on a power you
        // could have afforded anyway is the player's business; picking which to
        // spend it on is the interesting decision, and doing it automatically
        // would take that decision away.
        if w.free_uses[player][power] > 0 {
            w.free_uses[player][power] -= 1;
        } else {
            let cost = i32::from(w.cfg.power_cost[power]);
            if cost > 0 && !w.spend_mana(player, cost) {
                return;
            }
        }
    }

    // Counted here, past the gating, so the census reports what a log *did* and
    // not what it asked for. A verb rejected on cost or availability every single
    // time exercises nothing, and §6.3's coverage criterion would be satisfied by
    // a corpus that never ran the code (diagnostic only; see `world::Census`).
    if (cmd.verb as usize) < w.census.verb_applied.len() {
        let n = &mut w.census.verb_applied[cmd.verb as usize];
        *n = n.saturating_add(1);
    }

    let radius = World::brush_radius(cmd.modifier);

    // And *where*, for the renderer. Same place and same gating as the count
    // above, for the same reason: an effect that fires for a refused power tells
    // the player they cast something they did not. Instrumentation, excluded from
    // the state hash — `the_census_is_not_hashed` covers this too.
    {
        let slot = (w.census.verb_events_written as usize) % crate::world::VERB_EVENTS;
        w.census.verb_events[slot] = crate::world::VerbEvent {
            face: face as u8,
            x: cx as u8,
            y: cy as u8,
            verb: cmd.verb,
            player: player as u8,
            modifier: cmd.modifier,
            radius: radius.clamp(0, 255) as u8,
            _pad: 0,
        };
        w.census.verb_events_written = w.census.verb_events_written.wrapping_add(1);
    }
    match cmd.verb {
        VERB_RAISE => sculpt(w, player, face, cx, cy, radius, true),
        VERB_LOWER => sculpt(w, player, face, cx, cy, radius, false),
        VERB_MAGNET => {
            w.magnet[player].face = face as u8;
            w.magnet[player].x = cx as u8;
            w.magnet[player].y = cy as u8;
            w.magnet[player].active = 1;
            w.magnet[player].leader = u16::MAX;
        }
        VERB_EARTHQUAKE => earthquake(w, face, cx, cy, radius),
        VERB_SWAMP => swamp(w, face, cx, cy, radius),
        VERB_VOLCANO => volcano(w, face, cx, cy, radius),
        VERB_FLOOD => {
            // Raises global sea level one step. Damages both players (§5.2).
            // Capped: the rise is monotonic (there is deliberately no ebb
            // verb), and uncapped it drowns the whole planet in ~20 casts —
            // the corpus proved that empirically. A cast at the cap still
            // spends its mana; the gate above has already charged.
            w.sea_base = w.sea_base.saturating_add(TERRACE).min(FLOOD_CAP);
        }
        VERB_CHAMPION => {
            crate::walkers::make_champion(w, player);
        }
        VERB_ARMAGEDDON => crate::tide::trigger_armageddon(w),
        // Mixing is impossible: picking up a second material requires depositing
        // the first (§4.2). A full hand ignores the verb rather than swapping.
        VERB_SET_HAND if w.hand[player].amount == 0 => {
            w.hand[player].material = (cmd.x as u8).min(HAND_LAVA);
        }
        _ => {}
    }
}

/// Raise or lower whatever the hand is currently carrying.
///
/// The hand is a pipette, not only a shovel (§4.2): the same two verbs move
/// earth, water or lava depending on what is held, which is where "carry water
/// onto lava to make rock at a chosen location" comes from without a new verb.
fn sculpt(w: &mut World, player: usize, face: usize, cx: i32, cy: i32, radius: i32, raise: bool) {
    match w.hand[player].material {
        HAND_EARTH => {
            w.deform(player, face, cx, cy, radius, raise);
        }
        HAND_WATER => fluid(w, player, face, cx, cy, radius, raise, false),
        _ => fluid(w, player, face, cx, cy, radius, raise, true),
    }
}

fn fluid(
    w: &mut World,
    player: usize,
    face: usize,
    cx: i32,
    cy: i32,
    radius: i32,
    raise: bool,
    lava: bool,
) {
    let per_cell = i32::from(TERRACE) * 2;
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx * dx + dy * dy > radius * radius + radius {
                continue;
            }
            let Some((f, x, y)) = walk(face, cx, cy, dx, dy) else { continue };
            let c = idx(f, x, y);
            if raise {
                let take = per_cell.min(i32::from(w.hand[player].amount));
                if take <= 0 {
                    return;
                }
                if lava {
                    let room = 255 - i32::from(w.lava[c]);
                    let take = take.min(room);
                    if take <= 0 {
                        continue;
                    }
                    w.lava[c] += take as u8;
                    w.hand[player].amount -= take as u16;
                } else {
                    w.water[c] = w.water[c].saturating_add(take as i16);
                    w.hand[player].amount -= take as u16;
                }
            } else {
                let room = i32::from(HAND_CAPACITY) - i32::from(w.hand[player].amount);
                if room <= 0 {
                    return;
                }
                let have = if lava { i32::from(w.lava[c]) } else { i32::from(w.water[c]) };
                let take = per_cell.min(room).min(have);
                if take <= 0 {
                    continue;
                }
                if lava {
                    w.lava[c] -= take as u8;
                } else {
                    w.water[c] -= take as i16;
                }
                w.hand[player].amount += take as u16;
            }
        }
    }
}

/// Lowers and dents terrain (§5.2).
///
/// Nominally a weapon, in practice the repair tool for volcano damage — and the
/// only build tool at all on maps where raise/lower is disabled. It does not use
/// the hand, so it is the one way to move earth without conserving it; that is
/// what the mana cost pays for.
fn earthquake(w: &mut World, face: usize, cx: i32, cy: i32, radius: i32) {
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let d2 = dx * dx + dy * dy;
            if d2 > radius * radius {
                continue;
            }
            let Some((f, x, y)) = walk(face, cx, cy, dx, dy) else { continue };
            let c = idx(f, x, y);
            // Alternating dent so the result is broken ground, not a smooth bowl:
            // a plateau is what settlements need, and this destroys plateaus.
            let sign = if (x + y) % 2 == 0 { -1 } else { 1 };
            // Falls off with squared distance, which needs no square root and
            // therefore no float anywhere near simulation state.
            let span = radius * radius + 1;
            let amount = (i32::from(TERRACE) * 3 * (span - d2) / span).max(1);
            let delta = sign * amount;
            w.height[c] = (i32::from(w.height[c]) + delta)
                .clamp(i32::from(HEIGHT_MIN), i32::from(HEIGHT_MAX))
                as i16;
            if w.material[c] == crate::world::MAT_SOIL {
                w.material[c] = MAT_ASH;
            }
        }
    }
}

/// Created on flat ground; swallows walkers that enter (§5.2).
fn swamp(w: &mut World, face: usize, cx: i32, cy: i32, radius: i32) {
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if dx * dx + dy * dy > radius * radius {
                continue;
            }
            let Some((f, x, y)) = walk(face, cx, cy, dx, dy) else { continue };
            let c = idx(f, x, y);
            if w.water[c] > 0 || w.lava[c] > 0 {
                continue;
            }
            w.material[c] = MAT_SWAMP;
        }
    }
}

/// Opens a lava vent.
///
/// Its real function is generative (§4.4). Do not balance it as damage: it is
/// the most contested resource on the planet, because both gods need the same
/// crater to reclaim land the tide has taken.
fn volcano(w: &mut World, face: usize, cx: i32, cy: i32, radius: i32) {
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            let d2 = dx * dx + dy * dy;
            if d2 > radius * radius {
                continue;
            }
            let Some((f, x, y)) = walk(face, cx, cy, dx, dy) else { continue };
            let c = idx(f, x, y);
            let amount = (200 - d2 * 20).max(30);
            w.lava[c] = (i32::from(w.lava[c]) + amount).clamp(0, 255) as u8;
            w.water[c] = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// One-shot pickups (HANDOFF §5.3)
// ---------------------------------------------------------------------------

/// Ticks between spawn attempts. `[START]` 900 — one every 30 seconds, which is
/// the same cadence as a tide recovery window, so a pickup and a rebuild phase
/// arrive together.
pub const PICKUP_INTERVAL: u32 = 900;
/// How many may lie on the terrain at once. `[START]`.
pub const PICKUP_MAX_ACTIVE: usize = 4;

/// Spawn and collect one-shot pickups (§4.1 pass 8a).
pub fn pickups_step(w: &mut World) {
    collect_pickups(w);
    if w.tick > 0 && w.tick.is_multiple_of(PICKUP_INTERVAL) {
        spawn_pickup(w);
    }
}

/// A walker standing on a pickup takes it for its owner.
///
/// Walkers are visited in id order and pickups in slot order, so which walker
/// gets a contested pickup is a function of state alone.
fn collect_pickups(w: &mut World) {
    for slot in 0..MAX_PICKUPS {
        let p = w.pickups[slot];
        if !p.alive() {
            continue;
        }
        let cell = idx(p.face as usize, p.x as usize, p.y as usize);
        let Some(taker) =
            w.walkers.iter().find(|k| k.alive() && crate::walkers::cell_of(k) == cell)
        else {
            continue;
        };
        let owner = (taker.owner as usize) % PLAYERS;
        let power = (p.power as usize).min(POWER_COUNT - 1);
        w.free_uses[owner][power] = w.free_uses[owner][power].saturating_add(1);
        w.pickups[slot] = Pickup::default();
    }
}

/// Place a pickup on ground nobody holds.
///
/// Neutral ground is the whole point: a pickup inside your own influence is a
/// gift, and one outside it costs a magnet placement to reach. That is what
/// makes it a contested object rather than a race won by proximity.
fn spawn_pickup(w: &mut World) {
    let active = w.pickups.iter().filter(|p| p.alive()).count();
    if active >= PICKUP_MAX_ACTIVE {
        return;
    }
    let Some(slot) = w.pickups.iter().position(|p| !p.alive()) else {
        return;
    };

    // Two scans rather than a reservoir sample: the second scan is the same
    // deterministic walk as the first, so the choice depends only on the PRNG
    // draw and the world, and every candidate is equally likely.
    let mut candidates = 0u32;
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                if is_pickup_site(w, idx(face, x, y)) {
                    candidates += 1;
                }
            }
        }
    }
    if candidates == 0 {
        return;
    }
    let target = w.rng.below(candidates);

    // Which power. Only ones the map actually enables, and never raise/lower —
    // that verb is free already, so a charge for it would be no reward at all.
    let mut pool = [0u8; POWER_COUNT];
    let mut pool_len = 0usize;
    for power in 1..POWER_COUNT {
        if w.cfg.power_enabled[power] != 0 {
            pool[pool_len] = power as u8;
            pool_len += 1;
        }
    }
    if pool_len == 0 {
        return;
    }
    let power = pool[w.rng.below(pool_len as u32) as usize];

    let mut seen = 0u32;
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                if !is_pickup_site(w, idx(face, x, y)) {
                    continue;
                }
                if seen == target {
                    w.pickups[slot] = Pickup {
                        face: face as u8,
                        x: x as u8,
                        y: y as u8,
                        power,
                        flags: PICKUP_ALIVE,
                        _pad: [0; 3],
                    };
                    return;
                }
                seen += 1;
            }
        }
    }
}

/// Dry, walkable, and claimed by nobody.
fn is_pickup_site(w: &World, c: usize) -> bool {
    w.influence[c] == 0 && w.passable(c) && w.settle_of[c] == crate::world::NO_SETTLEMENT
}

// ---------------------------------------------------------------------------
// Manifest parser (HANDOFF §5.4)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParseError {
    pub line: u32,
    pub what: &'static str,
}

fn err(line: u32, what: &'static str) -> ParseError {
    ParseError { line, what }
}

fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (radix, digits) = if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        (16u32, hex)
    } else {
        (10u32, s)
    };
    if digits.is_empty() {
        return None;
    }
    let mut acc: i64 = 0;
    for ch in digits.chars() {
        if ch == '_' {
            continue;
        }
        let d = ch.to_digit(radix)? as i64;
        acc = acc.checked_mul(i64::from(radix))?.checked_add(d)?;
    }
    Some(if neg { -acc } else { acc })
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(s)
}

fn power_index(name: &str) -> Option<usize> {
    Some(match name {
        "raise_lower" => crate::world::POWER_RAISE_LOWER,
        "magnet" => crate::world::POWER_MAGNET,
        "earthquake" => crate::world::POWER_EARTHQUAKE,
        "swamp" => crate::world::POWER_SWAMP,
        "volcano" => crate::world::POWER_VOLCANO,
        "flood" => crate::world::POWER_FLOOD,
        "champion" => crate::world::POWER_CHAMPION,
        "armageddon" => crate::world::POWER_ARMAGEDDON,
        _ => return None,
    })
}

/// Parse the §5.4 manifest.
///
/// A manifest asking for an `n` other than the compiled [`N`] is an error, not a
/// silent no-op: the simulation crate is `no_std` with fixed-size arrays, so `n`
/// is a build-time constant. Reporting it beats generating a world of the wrong
/// size and desyncing thirty seconds later.
pub fn parse_manifest(src: &str) -> Result<MapConfig, ParseError> {
    let mut cfg = MapConfig::DEFAULT;
    let mut section: [u8; 32] = [0; 32];
    let mut section_len = 0usize;

    for (i, raw) in src.lines().enumerate() {
        let line_no = i as u32 + 1;
        let line = match raw.split_once('#') {
            Some((before, _)) => before,
            None => raw,
        }
        .trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix('[') {
            let name =
                rest.strip_suffix(']').ok_or_else(|| err(line_no, "unterminated section"))?;
            let bytes = name.trim().as_bytes();
            if bytes.len() > section.len() {
                return Err(err(line_no, "section name too long"));
            }
            section[..bytes.len()].copy_from_slice(bytes);
            section_len = bytes.len();
            continue;
        }

        let (key, value) =
            line.split_once('=').ok_or_else(|| err(line_no, "expected key = value"))?;
        let key = key.trim();
        let value = value.trim();
        let section = core::str::from_utf8(&section[..section_len]).unwrap_or("");

        match section {
            "world" => match key {
                "n" => {
                    let n = parse_int(value).ok_or_else(|| err(line_no, "n is not an integer"))?;
                    if n != N as i64 {
                        return Err(err(line_no, "n does not match the compiled grid size"));
                    }
                    cfg.n = n as u16;
                }
                "seed" => {
                    cfg.seed = parse_int(value)
                        .ok_or_else(|| err(line_no, "seed is not an integer"))?
                        as u32;
                }
                "terrain" => {
                    cfg.terrain = match unquote(value) {
                        "archipelago" => TERRAIN_ARCHIPELAGO,
                        "pangaea" => TERRAIN_PANGAEA,
                        "volcano" => TERRAIN_VOLCANO,
                        _ => return Err(err(line_no, "unknown terrain")),
                    };
                }
                _ => return Err(err(line_no, "unknown key in [world]")),
            },
            "mode" => match key {
                "kind" => {
                    if unquote(value) != "conquest" {
                        return Err(err(line_no, "unknown mode"));
                    }
                }
                "waves" => {
                    cfg.waves = parse_int(value)
                        .ok_or_else(|| err(line_no, "waves is not an integer"))?
                        .clamp(1, crate::world::MAX_WAVES as i64)
                        as u8;
                }
                "score" => {
                    if unquote(value) != "per_wave" {
                        return Err(err(line_no, "unknown scoring rule"));
                    }
                }
                _ => return Err(err(line_no, "unknown key in [mode]")),
            },
            "mode.tide" => {
                let v = parse_int(value).ok_or_else(|| err(line_no, "not an integer"))?;
                match key {
                    "telegraph_ticks" => cfg.telegraph_ticks = v.clamp(1, 100_000) as u32,
                    "impact_ticks" => cfg.impact_ticks = v.clamp(1, 100_000) as u32,
                    "recovery_ticks" => cfg.recovery_ticks = v.clamp(1, 100_000) as u32,
                    "escalation" => cfg.escalation = v.clamp(100, 1000) as u16,
                    "strength" => cfg.wave_strength = v.clamp(0, 4096) as i16,
                    _ => return Err(err(line_no, "unknown key in [mode.tide]")),
                }
            }
            "ai" => match key {
                "enabled" => {
                    cfg.ai_enabled =
                        u8::from(parse_bool(value).ok_or_else(|| err(line_no, "not a bool"))?);
                }
                "player" => {
                    cfg.ai_player = parse_int(value)
                        .ok_or_else(|| err(line_no, "not an integer"))?
                        .clamp(0, 1) as u8;
                }
                _ => return Err(err(line_no, "unknown key in [ai]")),
            },
            other => {
                let name =
                    other.strip_prefix("powers.").ok_or_else(|| err(line_no, "unknown section"))?;
                let p = power_index(name).ok_or_else(|| err(line_no, "unknown power"))?;
                match key {
                    "enabled" => {
                        cfg.power_enabled[p] =
                            u8::from(parse_bool(value).ok_or_else(|| err(line_no, "not a bool"))?);
                    }
                    "cost" => {
                        cfg.power_cost[p] = parse_int(value)
                            .ok_or_else(|| err(line_no, "cost is not an integer"))?
                            .clamp(0, i64::from(u16::MAX))
                            as u16;
                    }
                    _ => return Err(err(line_no, "unknown key in [powers.*]")),
                }
            }
        }
    }

    debug_assert_eq!(cfg.power_enabled.len(), POWER_COUNT);
    Ok(cfg)
}

// ---------------------------------------------------------------------------
// Session log (used by the replay verifier and by `just verify-cross`)
// ---------------------------------------------------------------------------

/// Header of a session log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogHeader {
    pub cfg: MapConfig,
    pub ticks: u32,
}

/// Parse the `key value` header lines of a session log.
///
/// Deliberately a different, dumber format from the manifest: a replay log is
/// machine-written and machine-read, and the fewer ways it can be expressed the
/// fewer ways a fixture can drift from the code that produced it.
pub fn parse_log_header(src: &str) -> Result<LogHeader, ParseError> {
    let mut cfg = MapConfig::DEFAULT;
    let mut ticks = 0u32;
    for (i, raw) in src.lines().enumerate() {
        let line_no = i as u32 + 1;
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("c ") {
            break;
        }
        let (key, value) =
            line.split_once(' ').ok_or_else(|| err(line_no, "expected key value"))?;
        let v = parse_int(value).ok_or_else(|| err(line_no, "not an integer"))?;
        match key {
            "seed" => cfg.seed = v as u32,
            "n" => {
                if v != N as i64 {
                    return Err(err(line_no, "log was recorded at a different grid size"));
                }
            }
            "terrain" => cfg.terrain = v.clamp(0, 2) as u8,
            "waves" => cfg.waves = v.clamp(1, crate::world::MAX_WAVES as i64) as u8,
            "ai" => cfg.ai_enabled = u8::from(v != 0),
            // Keep simulating past the decided outcome. Corpus logs set this:
            // a default match decides around tick 10,000 and a frozen second
            // half would gut the §6.3 coverage. Real matches freeze.
            "endless" => cfg.endless = u8::from(v != 0),
            // Bitmask over the power ids: bit `i` enables power `i`.
            //
            // Here because §6.3 asks a corpus to cover every verb at least 20
            // times and the shipped manifest cannot deliver that: §5.4 ships with
            // swamp disabled, so on the default config `VERB_SWAMP` is inert and
            // that criterion is unreachable by construction rather than by
            // accident. A corpus match can enable everything; keeping other
            // matches on the shipped mask is what keeps the *gating* path covered
            // too.
            "powers" => {
                for p in 0..POWER_COUNT {
                    cfg.power_enabled[p] = u8::from((v >> p) & 1 != 0);
                }
            }
            // Zero every power's mana cost.
            //
            // Also here for §6.3, and for the same reason: a determinism corpus
            // has to reach every verb's *effect*, and on the shipped costs the
            // expensive half of the verb set is unreachable — armageddon is 4,000
            // mana against an accrual of a fraction of one per tick, so a 20,000
            // tick match affords none of it. Cost is a `[START]` balance number
            // with no published source (`balance-research` TODO-1); determinism is
            // not. The gating path itself stays covered by the fixtures recorded
            // on the shipped manifest.
            "free_powers" => {
                if v != 0 {
                    cfg.power_cost = [0; POWER_COUNT];
                }
            }
            "ticks" => ticks = v.clamp(0, 10_000_000) as u32,
            _ => return Err(err(line_no, "unknown header key")),
        }
    }
    Ok(LogHeader { cfg, ticks })
}

/// Parse one `c <tick> <player> <verb> <face> <x> <y> <modifier>` line.
///
/// Returns `None` for any line that is not a command, so callers can feed the
/// whole file through without pre-filtering.
#[must_use]
pub fn parse_log_command(line: &str) -> Option<Command> {
    let rest = line.trim().strip_prefix("c ")?;
    let mut it = rest.split_whitespace();
    let mut next = || parse_int(it.next()?);
    let tick = next()?;
    let player = next()?;
    let verb = next()?;
    let face = next()?;
    let x = next()?;
    let y = next()?;
    let modifier = next()?;
    if it.next().is_some() {
        return None;
    }
    Some(Command {
        tick: tick.clamp(0, i64::from(u32::MAX)) as u32,
        player: player.clamp(0, 1) as u8,
        verb: verb.clamp(0, 255) as u8,
        face: face.clamp(0, 5) as u8,
        x: x.clamp(0, i64::from(u16::MAX)) as u16,
        y: y.clamp(0, i64::from(u16::MAX)) as u16,
        modifier: modifier.clamp(0, 255) as u8,
    })
}

/// Replay a whole session log and return the final world plus every recorded
/// state hash.
///
/// The CLI's `replay --verify` and the `determinism::cross_build_hash_matches`
/// test both go through here, so there is exactly one definition of what
/// replaying a log means. Two definitions is how a replay verifier ends up
/// agreeing with itself and with nothing else.
#[cfg(feature = "alloc")]
pub fn replay(
    src: &str,
) -> Result<(alloc::boxed::Box<World>, alloc::vec::Vec<(u32, u64)>), ParseError> {
    use crate::world::CommandBuf;

    let header = parse_log_header(src)?;
    let mut w = World::boxed();
    w.init(&header.cfg);

    // Commands are grouped by target tick. The log is written in tick order, so
    // one cursor over the lines is enough — no sorting, and therefore no sort
    // without a tiebreaker (§10).
    let mut pending: alloc::vec::Vec<Command> = alloc::vec::Vec::new();
    for line in src.lines() {
        if let Some(c) = parse_log_command(line) {
            pending.push(c);
        }
    }
    let mut cursor = 0usize;
    let mut hashes = alloc::vec::Vec::new();

    for tick in 0..header.ticks {
        let mut buf = CommandBuf::new();
        while cursor < pending.len() && pending[cursor].tick == tick {
            buf.push(pending[cursor]);
            cursor += 1;
        }
        w.tick(buf.as_slice());
        if tick % 30 == 0 {
            hashes.push((tick, w.last_hash));
        }
    }
    Ok((w, hashes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MAT_SOIL, MapConfig, POWER_SWAMP, TERRAIN_PANGAEA, VERB_NOP};

    const MANIFEST: &str = r#"
[world]
n = 64
seed = 0x5EED
terrain = "archipelago"

[mode]
kind = "conquest"
waves = 7                    # [START]
score = "per_wave"

[mode.tide]
telegraph_ticks = 300
recovery_ticks  = 900
escalation      = 115

[powers.earthquake]
enabled = true
cost = 120

[powers.swamp]
enabled = false

[powers.raise_lower]
enabled = true
"#;

    #[test]
    fn the_manifest_from_the_spec_parses() {
        let cfg = parse_manifest(MANIFEST).expect("spec manifest must parse");
        assert_eq!(cfg.seed, 0x5EED);
        assert_eq!(cfg.terrain, TERRAIN_ARCHIPELAGO);
        assert_eq!(cfg.waves, 7);
        assert_eq!(cfg.telegraph_ticks, 300);
        assert_eq!(cfg.recovery_ticks, 900);
        assert_eq!(cfg.escalation, 115);
        assert_eq!(cfg.power_cost[crate::world::POWER_EARTHQUAKE], 120);
        assert_eq!(cfg.power_enabled[POWER_SWAMP], 0);
        assert_eq!(cfg.power_enabled[crate::world::POWER_RAISE_LOWER], 1);
    }

    #[test]
    fn errors_carry_a_line_number() {
        let e = parse_manifest("[world]\nn = 64\nnope = 1\n").unwrap_err();
        assert_eq!(e.line, 3);
        let e = parse_manifest("[world]\nn = 96\n").unwrap_err();
        assert_eq!(e.line, 2);
        assert!(e.what.contains("grid size"));
    }

    /// Phase 6 DoD: "disabling a power in the manifest removes it from the game
    /// with no code change".
    #[test]
    fn a_disabled_power_is_inert() {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.power_enabled[POWER_SWAMP] = 0;
        cfg.power_cost[POWER_SWAMP] = 0;
        let mut w = World::boxed();
        w.init(&cfg);
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    let c = idx(face, x, y);
                    w.height[c] = 400;
                    w.water[c] = 0;
                    w.material[c] = MAT_SOIL;
                }
            }
        }
        let cmd =
            Command { tick: 0, x: 20, y: 20, player: 0, verb: VERB_SWAMP, face: 4, modifier: 0 };
        apply(&mut w, 0, &cmd);
        assert_eq!(w.material[idx(4, 20, 20)], MAT_SOIL, "a disabled power still fired");

        w.cfg.power_enabled[POWER_SWAMP] = 1;
        apply(&mut w, 0, &cmd);
        assert_eq!(w.material[idx(4, 20, 20)], MAT_SWAMP, "the enabled power did nothing");
    }

    #[test]
    fn a_power_you_cannot_afford_does_nothing_and_costs_nothing() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        w.init(&cfg);
        w.mana[0] = 0;
        let before = w.state_hash();
        apply(
            &mut w,
            0,
            &Command { tick: 0, x: 20, y: 20, player: 0, verb: VERB_VOLCANO, face: 4, modifier: 0 },
        );
        assert_eq!(w.state_hash(), before, "an unaffordable power changed the world");
        assert_eq!(w.mana[0], 0, "an unaffordable power still charged mana");
    }

    #[test]
    fn the_hand_carries_three_materials_and_never_mixes() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        w.init(&cfg);
        assert_eq!(w.hand[0].material, HAND_EARTH);

        // Switching is free while empty.
        apply(
            &mut w,
            0,
            &Command {
                tick: 0,
                x: u16::from(HAND_WATER),
                y: 0,
                player: 0,
                verb: VERB_SET_HAND,
                face: 0,
                modifier: 0,
            },
        );
        assert_eq!(w.hand[0].material, HAND_WATER);

        // With something in the hand it is refused.
        w.hand[0].amount = 100;
        apply(
            &mut w,
            0,
            &Command {
                tick: 0,
                x: u16::from(HAND_LAVA),
                y: 0,
                player: 0,
                verb: VERB_SET_HAND,
                face: 0,
                modifier: 0,
            },
        );
        assert_eq!(w.hand[0].material, HAND_WATER, "materials mixed in the hand");
    }

    #[test]
    fn carrying_water_moves_water_not_earth() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        w.init(&cfg);
        let c = idx(4, 10, 10);
        w.height[c] = 400;
        w.water[c] = 0;
        w.hand[0].material = HAND_WATER;
        w.hand[0].amount = 1000;
        let h_before = w.height[c];
        apply(
            &mut w,
            0,
            &Command { tick: 0, x: 10, y: 10, player: 0, verb: VERB_RAISE, face: 4, modifier: 0 },
        );
        assert_eq!(w.height[c], h_before, "a water-carrying hand moved earth");
        assert!(w.water[c] > 0, "a water-carrying hand deposited nothing");
        assert!(w.hand[0].amount < 1000);
    }

    #[test]
    fn flood_damages_both_players_symmetrically() {
        let mut w = World::boxed();
        w.init(&MapConfig::DEFAULT);
        let before = w.sea_base;
        w.mana[0] = 9999 << 16;
        apply(
            &mut w,
            0,
            &Command { tick: 0, x: 0, y: 0, player: 0, verb: VERB_FLOOD, face: 0, modifier: 0 },
        );
        assert_eq!(w.sea_base, before + TERRACE, "flood did not raise the sea");
        // There is no per-player sea level, which is the point: the strongest
        // board-wide power cannot be aimed (§4.6).
    }

    #[test]
    fn thrown_covers_more_ground_than_poured() {
        assert!(
            World::brush_radius(crate::world::MOD_THROWN) > World::brush_radius(0),
            "thrown and poured have the same radius"
        );
        assert!(
            World::brush_radius(crate::world::MOD_EXTREME)
                > World::brush_radius(crate::world::MOD_INCREASED)
        );
    }

    #[test]
    fn log_commands_roundtrip() {
        let line = "c 1200 1 6 4 33 17 5";
        let c = parse_log_command(line).expect("valid command line");
        assert_eq!(
            c,
            Command { tick: 1200, player: 1, verb: 6, face: 4, x: 33, y: 17, modifier: 5 }
        );
        assert!(parse_log_command("seed 42").is_none());
        assert!(parse_log_command("c 1 2").is_none());
        assert!(parse_log_command("c 1 2 3 4 5 6 7 8").is_none());
        assert_eq!(parse_log_command("c 0 0 0 0 0 0 0").unwrap().verb, VERB_NOP);
    }

    #[test]
    fn a_pickup_pays_for_exactly_one_use_and_then_stops() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        w.init(&cfg);
        w.mana[0] = 0;
        w.free_uses[0][crate::world::POWER_VOLCANO] = 1;

        let cmd =
            Command { tick: 0, x: 20, y: 20, player: 0, verb: VERB_VOLCANO, face: 4, modifier: 0 };
        apply(&mut w, 0, &cmd);
        assert!(w.lava[idx(4, 20, 20)] > 0, "the free use did not fire");
        assert_eq!(w.free_uses[0][crate::world::POWER_VOLCANO], 0, "the charge was not spent");
        assert_eq!(w.mana[0], 0, "a free use still charged mana");

        // Second attempt, no charge and no mana: nothing happens.
        w.lava[idx(4, 30, 30)] = 0;
        apply(
            &mut w,
            0,
            &Command { tick: 1, x: 30, y: 30, player: 0, verb: VERB_VOLCANO, face: 4, modifier: 0 },
        );
        assert_eq!(w.lava[idx(4, 30, 30)], 0, "a second use was free too");
    }

    #[test]
    fn pickups_appear_only_on_ground_nobody_holds() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.seed = 31;
        w.init(&cfg);

        let mut spawned = 0usize;
        for tick in 0..(PICKUP_INTERVAL * (PICKUP_MAX_ACTIVE as u32 + 2)) {
            w.tick = tick;
            pickups_step(&mut w);
            spawned = w.pickups.iter().filter(|p| p.alive()).count();
        }
        assert!(spawned > 0, "no pickup ever appeared");
        assert!(spawned <= PICKUP_MAX_ACTIVE, "{spawned} pickups exceed the cap");

        for p in w.pickups.iter().filter(|p| p.alive()) {
            let c = idx(p.face as usize, p.x as usize, p.y as usize);
            assert_eq!(w.influence[c], 0, "a pickup landed inside somebody's influence");
            assert!(w.passable(c), "a pickup landed somewhere unreachable");
            assert_ne!(
                p.power as usize,
                crate::world::POWER_RAISE_LOWER,
                "a pickup granted a free use of a verb that is already free"
            );
            assert_eq!(w.cfg.power_enabled[p.power as usize], 1, "a disabled power was granted");
        }
    }

    #[test]
    fn a_walker_standing_on_a_pickup_collects_it() {
        let mut w = World::boxed();
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        w.init(&cfg);
        for p in &mut w.pickups {
            *p = Pickup::default();
        }
        w.free_uses = [[0; POWER_COUNT]; PLAYERS];

        w.pickups[0] = Pickup {
            face: 4,
            x: 20,
            y: 20,
            power: crate::world::POWER_EARTHQUAKE as u8,
            flags: PICKUP_ALIVE,
            _pad: [0; 3],
        };
        // Nobody standing on it yet.
        pickups_step(&mut w);
        assert!(w.pickups[0].alive(), "an unattended pickup vanished");

        crate::walkers::spawn(&mut w, 1, 4, 20, 20, 2, crate::world::NO_SETTLEMENT).unwrap();
        pickups_step(&mut w);
        assert!(!w.pickups[0].alive(), "the walker did not take the pickup");
        assert_eq!(w.free_uses[1][crate::world::POWER_EARTHQUAKE], 1);
        assert_eq!(w.free_uses[0][crate::world::POWER_EARTHQUAKE], 0, "the wrong god was paid");
    }

    #[test]
    fn log_header_rejects_a_mismatched_grid() {
        assert!(parse_log_header("seed 1\nn 64\nticks 10\n").is_ok());
        assert!(parse_log_header("seed 1\nn 96\n").is_err());
    }

    #[test]
    fn flood_saturates_at_the_cap() {
        let mut w = crate::world::World::boxed();
        w.init(&MapConfig::DEFAULT);
        let casts = 2 * (FLOOD_CAP / crate::world::TERRACE) as usize;
        let cmd =
            Command { tick: 0, x: 0, y: 0, player: 0, verb: VERB_FLOOD, face: 0, modifier: 0 };
        for _ in 0..casts {
            w.mana[0] = 9_999 << 16;
            apply(&mut w, 0, &cmd);
        }
        assert_eq!(w.sea_base, FLOOD_CAP, "flood did not saturate at the cap");
        // The spawn plateaus must survive a maximally flooded planet.
        let (f, x, y) = crate::settlements::STARTS[0];
        w.sea_level = w.sea_base;
        assert!(w.passable(idx(f, x, y)), "the cap still drowns a spawn plateau");
    }

    /// Constants-level guard for the armageddon price: a plausible late-game
    /// holding (250 habitable cells, four settlements) must be able to save it
    /// up inside two tide cycles, computed with `accrue_mana`'s own integer
    /// formula. A retune that makes the stalemate breaker unreachable again
    /// should fail a test, not a playtest.
    #[test]
    fn armageddon_is_earnable_in_a_match() {
        let cells = 250i64;
        let mult = 16 + 4 * i64::from(crate::world::TIER_STRENGTH[2]);
        let per_tick_q16 = (cells * mult) << 16;
        let per_tick_units = (per_tick_q16 / (256 * 16)) >> 16;
        let cfg = MapConfig::DEFAULT;
        let two_cycles = 2 * i64::from(cfg.telegraph_ticks + cfg.impact_ticks + cfg.recovery_ticks);
        let earned = per_tick_units * two_cycles;
        let price = i64::from(cfg.power_cost[crate::world::POWER_ARMAGEDDON]);
        assert!(
            earned >= price,
            "armageddon ({price}) is out of reach: two late-game tide cycles earn only {earned}"
        );
    }
}
