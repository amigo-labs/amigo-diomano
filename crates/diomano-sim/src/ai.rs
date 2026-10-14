//! A scripted opponent.
//!
//! Not in the HANDOFF plan; a stand-in for the second god until netcode
//! exists. Two rules from its first brief still hold, and both are
//! load-bearing:
//!
//! - It emits [`Command`]s and nothing else. It has no privileged mutation path
//!   into the world, so anything it does, the player can do — and pillar 3 holds
//!   for it as much as for a human (it never issues an attack order, because
//!   there is no such verb to issue).
//! - It acts one move at a time, holds each verb long enough to watch and
//!   pauses after it, so the player learns the verbs by watching it use them.
//!
//! What changed is *why* it moves. The first version replayed a fixed table of
//! lessons aimed at offsets from its own town, and measured over the sweep it
//! lost to a player who never touched the controls: its digs drowned its own
//! coast, its mana sat at the 9,999 cap from minute ten, and on the shipped
//! archipelago its army never met anyone. This one plays the game the score
//! is kept in (§5.5): every wave peak counts the habitable cells under each
//! god's influence, so it
//!
//! 1. lifts its own land clear of the **next peak's waterline**
//!    ([`crate::tide::next_peak_level`]) with earth dug from ground nobody
//!    scores on — the shallow shelf, neutral land, and above `LEVEL_EASY`
//!    the enemy's own coast (never its home pedestal);
//! 2. spends mana instead of hoarding it: earthquakes on the enemy's best
//!    town, a flood only when the forecast says the enemy loses more land to
//!    it than it does, armageddon only to break a level score;
//! 3. marches when its style says so, over whatever land joins the two
//!    peoples.
//!
//! How well it does each of those is the difficulty ([`LEVEL_EASY`] …
//! [`LEVEL_HARD`]); which of them it prefers is the style ([`STYLE_TURTLE`] …).
//! Both are per side in [`MapConfig`](crate::world::MapConfig), so a mirror
//! match can pit one against another and `diomano-cli sweep --profile mirror`
//! can measure whether the better player wins.
//!
//! Fully deterministic: its only inputs are world state and its own hashed
//! bookkeeping, and every scan runs in a fixed order with fixed tie-breaks.

use crate::world::{
    AiState, Command, CommandBuf, HAND_CAPACITY, HAND_EARTH, MOD_EXTREME, MOD_INCREASED, MOD_MASK,
    N, NO_SETTLEMENT, PLAYERS, POWER_ARMAGEDDON, POWER_CHAMPION, POWER_EARTHQUAKE, POWER_FLOOD,
    POWER_MAGNET, POWER_VOLCANO, TERRACE, TIDE_CALM, TIDE_DONE, TIDE_RECOVERY, VERB_ARMAGEDDON,
    VERB_CHAMPION, VERB_EARTHQUAKE, VERB_FLOOD, VERB_LOWER, VERB_MAGNET, VERB_NOP, VERB_RAISE,
    VERB_VOLCANO, World, idx, live_neighbour,
};

/// Slow, generous, never steals and never floods. Thinks every four seconds.
pub const LEVEL_EASY: u8 = 0;
/// The default opponent.
pub const LEVEL_NORMAL: u8 = 1;
/// Fast, takes the enemy's land, times its armageddon.
pub const LEVEL_HARD: u8 = 2;
pub const LEVEL_COUNT: u8 = 3;

/// No preference: terraform, strike, flood as the forecast says.
pub const STYLE_BALANCED: u8 = 0;
/// Builds for the last wave and builds more; strikes at half the rate, never
/// floods, never ends the match early.
pub const STYLE_TURTLE: u8 = 1;
/// Marches on the enemy from the first wave and pays for champions.
pub const STYLE_RUSH: u8 = 2;
/// Spends on the sky: volcanoes instead of quakes, floods, armageddon.
pub const STYLE_DISASTER: u8 = 3;
pub const STYLE_COUNT: u8 = 4;

/// Cells around a home core the opponent never strikes inside: the platform
/// itself, which a quake leaves alone anyway (`settlements::is_home_platform`).
/// It was seven while only the core cell was spared and a wide quake beside
/// it could still shake the pedestal out from under it.
const CORE_CLEARANCE: usize = 2;

/// Cells around a home core the opponent never pours water or lava inside.
/// Water on the core is the core under water — sudden death by one pour — and
/// unlike a quake nothing in the rules stops it.
const SPILL_CLEARANCE: usize = 7;

/// Cells around a home core the opponent never digs inside, for the same
/// reason.
const CORE_DIG_CLEARANCE: usize = 5;

/// Earth moved by one held tick of a poured raise or dig: nine cells, a
/// terrace each.
const BRUSH_LOAD: u16 = 9 * TERRACE as u16;

/// The settings one (level, style) pair plays with.
#[expect(clippy::struct_excessive_bools, reason = "a const table row of independent switches")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tuning {
    /// Ticks between decisions while idle.
    pub think: u32,
    /// Ticks a raise or dig is held.
    pub hold: u32,
    /// Ticks of stillness after every move, so it can be watched.
    pub pause: u32,
    /// Waves that must have landed before it strikes.
    pub strike_after: u8,
    /// Minimum ticks between two strikes.
    pub strike_gap: u32,
    /// Mana it keeps back after paying for any power.
    pub reserve: i32,
    /// Digs the enemy's land for its own earth: 0 never, 1 open ground,
    /// 2 under its towns as well.
    pub steals: u8,
    /// Picks the best spot on the planet rather than the first good one.
    pub thorough: bool,
    pub floods: bool,
    pub armageddon: bool,
    /// Volcano rather than earthquake as its strike.
    pub volcano: bool,
    /// Sends the army at the enemy's strongest town, and buys champions.
    pub marches: bool,
    /// Brush modifier for strikes: how much of the enemy's land one quake
    /// breaks. The same `B` key a player cycles.
    pub strike_modifier: u8,
    /// Builds against the *last* wave's waterline instead of the next one:
    /// ground lifted once that never has to be lifted again.
    pub builds_for_last: bool,
}

/// The tuning for a level and a style. Out-of-range values clamp, so a
/// malformed config plays as the nearest real opponent instead of panicking.
#[must_use]
pub const fn tuning(level: u8, style: u8) -> Tuning {
    let mut t = match level {
        LEVEL_EASY => Tuning {
            think: 120,
            hold: 12,
            pause: 60,
            strike_after: 2,
            strike_gap: 1_800,
            reserve: 400,
            steals: 0,
            thorough: false,
            floods: false,
            armageddon: false,
            volcano: false,
            marches: false,
            strike_modifier: 0,
            builds_for_last: false,
        },
        LEVEL_NORMAL => Tuning {
            think: 45,
            hold: 24,
            pause: 24,
            strike_after: 1,
            strike_gap: 900,
            reserve: 200,
            steals: 1,
            thorough: true,
            floods: true,
            armageddon: false,
            volcano: false,
            marches: false,
            strike_modifier: MOD_INCREASED,
            builds_for_last: false,
        },
        _ => Tuning {
            think: 15,
            hold: 30,
            pause: 8,
            strike_after: 1,
            strike_gap: 450,
            reserve: 120,
            steals: 2,
            thorough: true,
            floods: true,
            armageddon: true,
            volcano: false,
            marches: false,
            strike_modifier: MOD_EXTREME,
            builds_for_last: false,
        },
    };
    match style {
        STYLE_TURTLE => {
            // Builds for the finale and builds more of it, strikes at half the
            // rate. It used to wait for the second wave to strike at all, and
            // won 8-41% against every other style: everyone else was spending
            // from the first wave on while it sat on a full purse.
            t.strike_gap *= 2;
            t.hold = t.hold * 3 / 2;
            t.pause = if t.pause / 2 < 8 { 8 } else { t.pause / 2 };
            t.builds_for_last = true;
            t.armageddon = false;
            t.floods = false;
        }
        STYLE_RUSH => {
            t.marches = true;
            t.strike_after = 0;
            t.strike_gap = t.strike_gap * 2 / 3;
        }
        STYLE_DISASTER => {
            // Volcanoes at the level's own pace. At twice the pace it beat
            // every other style 66-83% of the time in the mirror sweep.
            t.volcano = true;
            t.floods = true;
            t.armageddon = level != LEVEL_EASY;
        }
        _ => {}
    }
    t
}

/// Emit this tick's commands for every scripted player.
///
/// Runs inside the tick (pass 2b in [`World::tick`]) and its output is applied
/// through exactly the same path as a human's input.
pub fn step(w: &mut World, out: &mut CommandBuf) {
    // A decided match silences the opponent — except in endless worlds, where
    // the world itself keeps running (the §6.3 corpus) and a mute opponent
    // would halve the coverage of exactly the phase the corpus is there for.
    if w.outcome != 0 && w.cfg.endless == 0 {
        return;
    }
    let primary = (w.cfg.ai_player as usize) % PLAYERS;
    for player in 0..PLAYERS {
        if player == primary || w.cfg.ai_mirror != 0 {
            step_player(w, player, out);
        }
    }
}

fn step_player(w: &mut World, player: usize, out: &mut CommandBuf) {
    let t = tuning(w.cfg.ai_level[player], w.cfg.ai_style[player]);
    let a = w.ai[player];

    if a.verb != VERB_NOP && a.holding != 0 {
        if a.timer == 0 || !still_worth_holding(w, player, &a) {
            // Done: stand back and let the world respond.
            w.ai[player].holding = 0;
            w.ai[player].timer = t.pause;
            return;
        }
        w.ai[player].timer = a.timer - 1;
        // Only the sculpting verbs are held; a power is paid for once.
        if a.verb == VERB_RAISE || a.verb == VERB_LOWER {
            emit(w, player, out, a.verb, (a.face, a.x, a.y), a.modifier);
        }
        return;
    }
    if a.timer > 0 {
        w.ai[player].timer = a.timer - 1;
        return;
    }
    if a.verb != VERB_NOP {
        // The pause is over.
        w.ai[player].verb = VERB_NOP;
    }

    w.ai[player].decisions = w.ai[player].decisions.wrapping_add(1);
    let Some((verb, at, modifier)) = decide(w, player, &t) else {
        w.ai[player].timer = t.think;
        return;
    };
    let held = verb == VERB_RAISE || verb == VERB_LOWER;
    if verb_power_cost(w, verb).is_some() && !held && verb != VERB_MAGNET {
        w.ai[player].strikes = w.ai[player].strikes.wrapping_add(1);
        w.ai[player].last_strike = w.tick;
    }
    w.ai[player] = AiState {
        face: at.0,
        x: at.1,
        y: at.2,
        verb,
        modifier,
        holding: 1,
        timer: if held { t.hold - 1 } else { 0 },
        ..w.ai[player]
    };
    emit(w, player, out, verb, at, modifier);
}

fn emit(w: &World, player: usize, out: &mut CommandBuf, verb: u8, at: (u8, u8, u8), modifier: u8) {
    out.push(Command {
        tick: w.tick,
        x: u16::from(at.1),
        y: u16::from(at.2),
        player: player as u8,
        verb,
        face: at.0,
        modifier: modifier & MOD_MASK,
    });
}

/// A raise stops when the hand is empty, a dig when it is full: holding on
/// past that is a refused verb every tick, which the client reads as an error.
/// Either stops the moment one of its own towns stands under the brush: a
/// held raise levels ground (`World::deform`), a settlement founds itself on
/// the level ground mid-hold, and the next tick of the same raise would break
/// the plateau it just made.
fn still_worth_holding(w: &World, player: usize, a: &AiState) -> bool {
    let amount = w.hand[player].amount;
    let sculpting = match a.verb {
        VERB_RAISE => amount > 0,
        VERB_LOWER => amount <= HAND_CAPACITY - BRUSH_LOAD,
        _ => return true,
    };
    sculpting && !brush_covers_own_town(w, player, a)
}

fn brush_covers_own_town(w: &World, player: usize, a: &AiState) -> bool {
    let r = World::brush_radius(a.modifier);
    for dy in -r..=r {
        for dx in -r..=r {
            let Some((f, x, y)) =
                crate::world::walk(usize::from(a.face), i32::from(a.x), i32::from(a.y), dx, dy)
            else {
                continue;
            };
            let slot = w.settle_of[idx(f, x, y)];
            if slot != NO_SETTLEMENT
                && w.settlements[slot as usize].alive()
                && w.settlements[slot as usize].owner as usize == player
            {
                return true;
            }
        }
    }
    false
}

fn verb_power_cost(w: &World, verb: u8) -> Option<i32> {
    crate::world::verb_power(verb).map(|p| i32::from(w.cfg.power_cost[p]))
}

/// What to do next, in priority order. `None` means: nothing worth doing,
/// think again later.
fn decide(w: &World, player: usize, t: &Tuning) -> Option<(u8, (u8, u8, u8), u8)> {
    let enemy = (player + 1) % PLAYERS;
    let mana = w.mana_units(player);
    let landed = crate::tide::waves_landed(w);
    let afford = |power: usize| -> bool {
        w.cfg.power_enabled[power] != 0
            && (w.free_uses[player][power] > 0
                || mana >= i32::from(w.cfg.power_cost[power]) + t.reserve)
    };
    let between_waves = w.tide.phase == TIDE_CALM || w.tide.phase == TIDE_RECOVERY;

    // 1. Armageddon, as the stalemate breaker it is: waves level, one
    // natural wave left, and a doubled final wave would go its way where the
    // natural one would not. Cast whenever it was merely ahead, it ended
    // matches at three minutes — a shortcut, not a breaker.
    let finale = landed.saturating_add(1) >= w.cfg.waves;
    if t.armageddon
        && finale
        && between_waves
        && afford(POWER_ARMAGEDDON)
        && armageddon_wins(w, player)
    {
        return Some((VERB_ARMAGEDDON, home(player), 0));
    }

    // 2. Flood, when the forecast says the enemy has more to lose.
    if t.floods
        && between_waves
        && w.sea_base < crate::powers::FLOOD_CAP
        && afford(POWER_FLOOD)
        && flood_pays(w, player)
    {
        return Some((VERB_FLOOD, home(player), 0));
    }

    // 3. Strike the enemy's best town.
    let spaced =
        w.ai[player].strikes == 0 || w.tick.wrapping_sub(w.ai[player].last_strike) >= t.strike_gap;
    if landed >= t.strike_after && spaced {
        // Lava runs, so a vent keeps the clearance a spill does: the platform
        // is immune to quakes, not to lava, and a vent beside it poured over
        // the core — the disaster style won every mirror match by sudden
        // death at five minutes once quakes were allowed that close.
        let (verb, power, clearance, spot) = if t.volcano && afford(POWER_VOLCANO) {
            (VERB_VOLCANO, POWER_VOLCANO, SPILL_CLEARANCE, Spot::Vent)
        } else {
            (VERB_EARTHQUAKE, POWER_EARTHQUAKE, CORE_CLEARANCE, Spot::Strike)
        };
        // A town if there is one; once there is none, the enemy's best
        // remaining ground — a home core keeps scoring without a single town.
        if afford(power)
            && let Some(at) =
                best_enemy_town(w, enemy, Some(clearance)).or_else(|| best_spot(w, player, t, spot))
        {
            return Some((verb, at, t.strike_modifier));
        }
    }

    // 4. March — but only over land. With the magnet on the enemy and no
    // path to it from home (the flow field's distance there is the fallback's,
    // `FALLBACK_BASE` and up), a march is mana spent on nothing: on two of the
    // three terrains the spawns share no land, and the rush style that kept
    // paying for magnets and champions there won 8-16% of its matches. It
    // falls through to terraforming until land joins the two peoples; the
    // flow field notices within fifteen ticks when it does.
    let m = w.magnet[player];
    let (hf, hx, hy) = crate::settlements::STARTS[player];
    let stranded =
        m.active != 0 && w.dist[player][idx(hf, hx, hy)] >= crate::flowfield::FALLBACK_BASE;
    if t.marches
        && !stranded
        && afford(POWER_MAGNET)
        && let Some(at) = best_enemy_town(w, enemy, None)
    {
        if m.active == 0 || (m.face, m.x, m.y) != at {
            return Some((VERB_MAGNET, at, 0));
        }
        if afford(POWER_CHAMPION) && walker_count(w, player) >= 4 {
            return Some((VERB_CHAMPION, at, 0));
        }
    }

    // 5. Terraform against the next waterline.
    terraform(w, player, t)
}

/// Where a power with no target of its own is "cast": over home.
fn home(player: usize) -> (u8, u8, u8) {
    let (f, x, y) = crate::settlements::STARTS[player];
    (f as u8, x as u8, y as u8)
}

fn walker_count(w: &World, player: usize) -> usize {
    w.walkers.iter().filter(|k| k.alive() && k.owner as usize == player).count()
}

/// Which god a cell's influence belongs to.
#[inline]
fn owner_of(w: &World, c: usize) -> Option<usize> {
    match w.influence[c] {
        0 => None,
        v if v > 0 => Some(0),
        _ => Some(1),
    }
}

/// The sea level that matters next: the coming peak, or the calm sea once no
/// wave is left.
fn waterline(w: &World) -> i32 {
    i32::from(crate::tide::next_peak_level(w).unwrap_or(w.sea_base))
}

/// The waterline of the last natural wave's peak, or the calm sea once the
/// tide is done.
fn last_waterline(w: &World) -> i32 {
    if w.tide.phase == TIDE_DONE {
        return i32::from(w.sea_base);
    }
    let last = w.cfg.waves.saturating_sub(1);
    i32::from(w.sea_base) + i32::from(crate::tide::wave_strength(w, last))
}

/// Habitable cells each god holds that stand above `level`.
fn held_above(w: &World, level: i32) -> [i32; PLAYERS] {
    let mut held = [0i32; PLAYERS];
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                if i32::from(w.height[c]) <= level || !w.habitable(c) {
                    continue;
                }
                if let Some(p) = owner_of(w, c) {
                    held[p] += 1;
                }
            }
        }
    }
    held
}

/// A flood raises the calm sea one terrace for good. Worth it only when the
/// land it drowns at the next peak is mostly the enemy's.
fn flood_pays(w: &World, player: usize) -> bool {
    let enemy = (player + 1) % PLAYERS;
    let line = waterline(w);
    let now = held_above(w, line);
    let after = held_above(w, line + i32::from(TERRACE));
    let mine_lost = now[player] - after[player];
    let theirs_lost = now[enemy] - after[enemy];
    let margin = (now[enemy] / 20).max(8);
    theirs_lost - mine_lost >= margin
}

/// Armageddon jumps to the last wave at double strength; the skipped waves
/// score nobody. Worth it only when the waves stand level and the doubled
/// final wave turns a loss into a win.
fn armageddon_wins(w: &World, player: usize) -> bool {
    let enemy = (player + 1) % PLAYERS;
    if w.tide.phase == TIDE_DONE {
        return false;
    }
    let mut won = [0i32; PLAYERS];
    for wave in 0..usize::from(crate::tide::waves_landed(w)).min(crate::world::MAX_WAVES) {
        let (a, b) = (w.score[0][wave], w.score[1][wave]);
        if a > b {
            won[0] += 1;
        } else if b > a {
            won[1] += 1;
        }
    }
    // Only from level: ahead, the natural waves already win it; behind,
    // one more wave cannot.
    if won[player] != won[enemy] {
        return false;
    }
    let last = w.cfg.waves.saturating_sub(1);
    let natural = i32::from(w.sea_base) + i32::from(crate::tide::wave_strength(w, last));
    let doubled =
        i32::from(w.sea_base) + i32::from(crate::tide::wave_strength(w, last)).saturating_mul(2);
    let calm = held_above(w, natural);
    let storm = held_above(w, doubled);
    let margin = (storm[enemy] / 8).max(8);
    // The doubled wave wins it where the natural one would not: the god who
    // built higher calls down the sea that only high ground survives.
    calm[player] <= calm[enemy] && storm[player] > storm[enemy] + margin
}

/// The enemy settlement most worth breaking: highest tier, then one that
/// would still score at the next peak, then the lowest slot. `strike` skips
/// the ones within `clearance` of a home core; a march (`None`) may go anywhere.
fn best_enemy_town(w: &World, enemy: usize, clearance: Option<usize>) -> Option<(u8, u8, u8)> {
    let line = waterline(w);
    let mut best: Option<(i32, usize)> = None;
    for (i, s) in w.settlements.iter().enumerate() {
        if !s.alive()
            || s.owner as usize != enemy
            || clearance
                .is_some_and(|r| near_home_core(s.face as usize, s.x as usize, s.y as usize, r))
        {
            continue;
        }
        let c = idx(s.face as usize, s.x as usize, s.y as usize);
        let value = i32::from(s.tier) * 4 + if i32::from(w.height[c]) > line { 3 } else { 0 };
        if best.is_none_or(|(v, _)| value > v) {
            best = Some((value, i));
        }
    }
    best.map(|(_, i)| {
        let s = w.settlements[i];
        (s.face, s.x, s.y)
    })
}

/// Raise where the next peak would drown own land, or dig earth to do it with.
fn terraform(w: &World, player: usize, t: &Tuning) -> Option<(u8, (u8, u8, u8), u8)> {
    let hand = w.hand[player];
    if hand.amount > 0 && hand.material != HAND_EARTH {
        // Water or lava in the hand (picked up by a dig that started over the
        // sea). Pour it where it hurts: on the enemy's land.
        let at = best_spot(w, player, t, Spot::Spill)?;
        return Some((VERB_RAISE, at, 0));
    }
    if hand.amount >= BRUSH_LOAD
        && let Some(at) = best_spot(w, player, t, Spot::Build)
    {
        return Some((VERB_RAISE, at, 0));
    }
    if hand.amount <= HAND_CAPACITY - BRUSH_LOAD
        && let Some(at) = best_spot(w, player, t, Spot::Dig)
    {
        return Some((VERB_LOWER, at, 0));
    }
    // A hand too full to dig and nothing worth building: empty it where it
    // costs nobody, or the opponent stands frozen with a full hand for the
    // rest of the match (traced, at LEVEL_HARD, from 2:25 on).
    if hand.amount > HAND_CAPACITY - BRUSH_LOAD
        && let Some(at) = best_spot(w, player, t, Spot::Dump)
    {
        return Some((VERB_RAISE, at, 0));
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Spot {
    /// Where a poured raise saves the most own land from the next peak.
    Build,
    /// Where a dig costs the opponent's own score least.
    Dig,
    /// Where a hand of water or lava does the enemy most harm.
    Spill,
    /// Where a strike breaks the most enemy ground that would score.
    Strike,
    /// The same, for a vent: kept as far from a home core as a spill.
    Vent,
    /// A full hand with nothing worth saving: the deep shelf off its own
    /// coast, which is new land one day and harms nobody now.
    Dump,
}

/// Scan every brush centre on the planet (interior cells, so the poured brush
/// never crosses a seam) and score it. Thorough players take the best; easy
/// ones take the first good one from a start point that walks with their
/// decision count, which reads as a player who notices *a* problem rather
/// than the worst one.
fn best_spot(w: &World, player: usize, t: &Tuning, kind: Spot) -> Option<(u8, u8, u8)> {
    let building = matches!(kind, Spot::Build | Spot::Dump);
    let line = if building && t.builds_for_last { last_waterline(w) } else { waterline(w) };
    let threshold = match kind {
        Spot::Build => 4,
        Spot::Dig => 3,
        Spot::Spill => 1,
        Spot::Strike | Spot::Vent => 5,
        Spot::Dump => 1,
    };
    let span = 6 * (N - 2) * (N - 2);
    let start = if t.thorough { 0 } else { (usize::from(w.ai[player].decisions) * 7_919) % span };
    let mut best: Option<(i32, usize)> = None;
    for k in 0..span {
        let i = (start + k) % span;
        let face = i / ((N - 2) * (N - 2));
        let rest = i % ((N - 2) * (N - 2));
        let (x, y) = (1 + rest % (N - 2), 1 + rest / (N - 2));
        let Some(score) = score_spot(w, player, t, kind, line, face, x, y) else { continue };
        if score < threshold {
            continue;
        }
        if !t.thorough {
            return Some((face as u8, x as u8, y as u8));
        }
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| {
        let face = i / ((N - 2) * (N - 2));
        let rest = i % ((N - 2) * (N - 2));
        (face as u8, (1 + rest % (N - 2)) as u8, (1 + rest / (N - 2)) as u8)
    })
}

/// The 3x3 brush at `(face, x, y)`, scored for `kind`. `None` is a veto.
#[expect(clippy::too_many_arguments, reason = "one scan's fixed inputs")]
fn score_spot(
    w: &World,
    player: usize,
    t: &Tuning,
    kind: Spot,
    line: i32,
    face: usize,
    x: usize,
    y: usize,
) -> Option<i32> {
    let centre = idx(face, x, y);
    if kind == Spot::Dig && w.material_under(centre) != HAND_EARTH {
        return None; // an empty hand would come up with water or lava
    }
    let terrace = i32::from(TERRACE);
    let sea = i32::from(w.sea_level);
    let mut score = 0i32;
    for dy in 0..3usize {
        for dx in 0..3usize {
            let c = idx(face, x + dx - 1, y + dy - 1);
            let h = i32::from(w.height[c]);
            let owner = owner_of(w, c);
            let mine = owner == Some(player);
            let theirs = owner.is_some() && !mine;
            let slot = w.settle_of[c];
            let town = slot != NO_SETTLEMENT && w.settlements[slot as usize].alive();
            let town_mine = town && w.settlements[slot as usize].owner as usize == player;
            if w.lava[c] > 0 && kind != Spot::Spill {
                return None;
            }
            match kind {
                Spot::Build | Spot::Dump => {
                    // Never on a footprint: a settlement is only as good as
                    // the exact flatness under it.
                    if town {
                        return None;
                    }
                    let shore = !mine
                        && owner.is_none()
                        && (0..4).any(|d| owner_of(w, live_neighbour(c, d)) == Some(player));
                    if !(mine || shore) || h >= line + terrace {
                        continue;
                    }
                    if h >= line - 2 * terrace {
                        score += 3; // one or two raises lift it clear
                    } else if h > sea - 8 * terrace {
                        score += 2; // the shelf off its own coast: new land
                    } else if kind == Spot::Dump {
                        score += 1;
                    }
                }
                Spot::Dig => {
                    // Never the enemy's home pedestal: sudden death is meant
                    // to be "my land drowned" (docs/specs/pacing.md), and a
                    // quake already leaves the core alone. Digging it out from
                    // under an idle player by hand was the fastest win in the
                    // sweep, and the least interesting one.
                    if town_mine || near_home_core(face, x + dx - 1, y + dy - 1, CORE_DIG_CLEARANCE)
                    {
                        return None;
                    }
                    if town {
                        if t.steals < 2 {
                            return None;
                        }
                        score += 4;
                        continue;
                    }
                    if mine {
                        score -= if h >= line + terrace { 6 } else { 1 };
                    } else if theirs {
                        if t.steals == 0 {
                            return None;
                        }
                        // A dig levels what it cuts (`World::deform`), so
                        // taking the enemy's ground is only taking it when it
                        // ends up under the next peak's water. Cut it down to a
                        // flat patch still above the line and it is a building
                        // site handed to them: traced on a pangaea seed, an
                        // idle player whose coast the opponent kept digging
                        // held 697 cells at the first peak against 265
                        // without it.
                        score += if h - terrace <= line {
                            3
                        } else if h >= line {
                            -2
                        } else {
                            0
                        };
                    } else if w.passable(c) {
                        // Nobody's land — unless it borders the enemy's, where
                        // the levelled patch is theirs to found on next.
                        let borders_enemy = (0..4).any(|d| {
                            owner_of(w, live_neighbour(c, d)).is_some_and(|o| o != player)
                        });
                        score += if borders_enemy { -1 } else { 1 };
                    } else if h < line - 4 * terrace {
                        score += 2; // the shelf: earth nobody will miss
                    }
                }
                Spot::Spill => {
                    // Water on a home core is the core under water: sudden
                    // death by one pour. Traced in a mirror match — both sides
                    // dug the same spot in the same tick, the second hand came
                    // up full of the sea the first had just let in, and it
                    // went onto the other side's core.
                    if town_mine
                        || mine
                        || near_home_core(face, x + dx - 1, y + dy - 1, SPILL_CLEARANCE)
                    {
                        return None;
                    }
                    if theirs {
                        score += if town { 4 } else { 1 };
                    }
                }
                Spot::Strike | Spot::Vent => {
                    let clearance =
                        if kind == Spot::Vent { SPILL_CLEARANCE } else { CORE_CLEARANCE };
                    if mine || near_home_core(face, x, y, clearance) {
                        return None;
                    }
                    if theirs && h > line && w.habitable(c) {
                        score += 1;
                    }
                }
            }
        }
    }
    Some(score)
}

/// Within `r` cells of either spawn cell.
fn near_home_core(face: usize, x: usize, y: usize, r: usize) -> bool {
    crate::settlements::STARTS
        .iter()
        .any(|&(f, sx, sy)| f == face && x.abs_diff(sx) <= r && y.abs_diff(sy) <= r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MapConfig, TERRAIN_PANGAEA, VERB_CHAMPION, VERB_COUNT, verb_power};

    fn ai_world() -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.ai_enabled = 1;
        cfg.ai_player = 1;
        cfg.seed = 909;
        let mut w = World::boxed();
        w.init(&cfg);
        w
    }

    /// The commands `step` emits over `ticks` real ticks of a world.
    fn emitted(w: &mut World, ticks: u32) -> std::vec::Vec<Command> {
        let mut all = std::vec::Vec::new();
        for _ in 0..ticks {
            let mut buf = CommandBuf::new();
            let saved = w.ai;
            step(w, &mut buf);
            w.ai = saved;
            all.extend_from_slice(buf.as_slice());
            w.tick(&[]);
        }
        all
    }

    #[test]
    fn the_opponent_only_uses_verbs_the_player_also_has() {
        // The teaching claim is only true if this holds. A verb the AI can use
        // and the player cannot would be a tutorial for something that is not
        // in the game.
        let mut w = ai_world();
        for c in emitted(&mut w, 3_000) {
            assert!(c.verb < VERB_COUNT, "unknown verb {}", c.verb);
            assert!(verb_power(c.verb).is_some(), "verb {} is not a player-facing power", c.verb);
        }
    }

    #[test]
    fn the_opponent_never_touches_the_world_directly() {
        // `step` may only write to its own bookkeeping. Anything else would be
        // a privileged mutation path, and pillar 3 would stop being enforceable.
        let mut w = ai_world();
        let mut buf = CommandBuf::new();
        let before = w.state_hash();
        let ai_before = w.ai;
        for _ in 0..500 {
            buf.clear();
            step(&mut w, &mut buf);
        }
        assert_ne!(w.ai, ai_before, "500 steps did not advance the opponent's own state");
        w.ai = ai_before;
        assert_eq!(
            w.state_hash(),
            before,
            "the scripted opponent mutated hashed state instead of emitting commands"
        );
    }

    #[test]
    fn it_actually_emits_commands_and_holds_them_long_enough_to_watch() {
        let mut w = ai_world();
        let cmds = emitted(&mut w, 3_000);
        let digs = cmds.iter().filter(|c| c.verb == VERB_LOWER).count();
        let raises = cmds.iter().filter(|c| c.verb == VERB_RAISE).count();
        assert!(digs > 20, "the opponent barely dug ({digs} commands)");
        assert!(raises > 20, "the opponent barely built ({raises} commands)");
        for c in &cmds {
            assert_eq!(usize::from(c.player), usize::from(w.cfg.ai_player));
        }
        // Pauses exist at every level: a move is never followed by another
        // the very next tick unless it is the same held verb.
        for level in 0..LEVEL_COUNT {
            for style in 0..STYLE_COUNT {
                let t = tuning(level, style);
                assert!(t.pause >= 8, "level {level} style {style} pauses {} ticks", t.pause);
                assert!(t.hold >= 10, "level {level} style {style} holds {} ticks", t.hold);
            }
        }
    }

    #[test]
    fn it_is_deterministic_across_runs() {
        let run = || {
            let mut w = ai_world();
            let mut acc = std::vec::Vec::new();
            for _ in 0..1_200 {
                let mut buf = CommandBuf::new();
                step(&mut w, &mut buf);
                acc.extend_from_slice(buf.as_slice());
                w.tick(&[]);
            }
            (acc, w.state_hash())
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn a_mirror_match_runs_both_sides_and_stays_reproducible() {
        let run = || {
            let mut cfg = MapConfig::DEFAULT;
            cfg.ai_enabled = 1;
            cfg.ai_mirror = 1;
            cfg.ai_level = [LEVEL_HARD, LEVEL_EASY];
            cfg.ai_style = [STYLE_DISASTER, STYLE_TURTLE];
            let mut w = World::boxed();
            w.init(&cfg);
            for _ in 0..4_000 {
                w.tick(&[]);
            }
            (w.state_hash(), w.ai)
        };
        let (h, ai) = run();
        assert_eq!(run().0, h);
        assert!(ai[0].decisions > 0 && ai[1].decisions > 0, "a mirror match left a side idle");
    }

    #[test]
    fn the_hash_without_an_opponent_ignores_its_configuration() {
        // Level, style and mirror are configuration, not state: a world with
        // the opponent off hashes the same whatever they say, which is what
        // keeps every recorded fixture without an opponent valid.
        let make = |level: u8| {
            let mut cfg = MapConfig::DEFAULT;
            cfg.ai_level = [level; PLAYERS];
            let mut w = World::boxed();
            w.init(&cfg);
            for _ in 0..300 {
                w.tick(&[]);
            }
            w.state_hash()
        };
        assert_eq!(make(LEVEL_EASY), make(LEVEL_HARD));
    }

    #[test]
    fn the_opponent_never_reshapes_ground_under_its_own_towns() {
        let mut cfg = MapConfig::DEFAULT;
        cfg.ai_enabled = 1;
        cfg.ai_level = [LEVEL_HARD; PLAYERS];
        cfg.seed = 0x9E37_D8A6;
        let mut w = World::boxed();
        w.init(&cfg);
        let mut checked = 0;
        for _ in 0..4_000 {
            let mut buf = CommandBuf::new();
            let saved = w.ai;
            step(&mut w, &mut buf);
            w.ai = saved;
            for c in buf.as_slice().iter().filter(|c| c.verb == VERB_RAISE || c.verb == VERB_LOWER)
            {
                let r = World::brush_radius(c.modifier);
                for dy in -r..=r {
                    for dx in -r..=r {
                        let Some((f, x, y)) = crate::world::walk(
                            c.face as usize,
                            i32::from(c.x),
                            i32::from(c.y),
                            dx,
                            dy,
                        ) else {
                            continue;
                        };
                        let slot = w.settle_of[idx(f, x, y)];
                        assert!(
                            slot == NO_SETTLEMENT
                                || !w.settlements[slot as usize].alive()
                                || w.settlements[slot as usize].owner != 1,
                            "tick {}: verb {} at f{} {},{} lands on the opponent's own town",
                            w.tick,
                            c.verb,
                            c.face,
                            c.x,
                            c.y
                        );
                    }
                }
                checked += 1;
            }
            w.tick(&[]);
        }
        assert!(checked > 20, "only {checked} sculpting moves were checked");
    }

    #[test]
    fn an_easy_opponent_never_digs_the_enemys_land() {
        for (level, may) in [(LEVEL_EASY, false), (LEVEL_NORMAL, true), (LEVEL_HARD, true)] {
            let mut cfg = MapConfig::DEFAULT;
            cfg.ai_enabled = 1;
            cfg.ai_level = [level; PLAYERS];
            cfg.terrain = TERRAIN_PANGAEA;
            let mut w = World::boxed();
            w.init(&cfg);
            let mut stole = false;
            for _ in 0..3_000 {
                let mut buf = CommandBuf::new();
                let saved = w.ai;
                step(&mut w, &mut buf);
                w.ai = saved;
                for c in buf.as_slice().iter().filter(|c| c.verb == VERB_LOWER) {
                    let cell = idx(c.face as usize, c.x as usize, c.y as usize);
                    if owner_of(&w, cell) == Some(0) {
                        stole = true;
                    }
                }
                w.tick(&[]);
            }
            if !may {
                assert!(!stole, "level {level} dug the enemy's land");
            }
        }
    }

    /// The sea's clock moved on to `waves` waves landed, nothing else touched.
    fn after_waves(w: &mut World, waves: u8) {
        w.tide.wave = waves;
        w.tide.scored = 0;
        w.tide.phase = TIDE_RECOVERY;
        w.tide.wave = waves.saturating_sub(1);
        assert_eq!(crate::tide::waves_landed(w), waves);
    }

    fn strikes(w: &mut World, mana: i32, ticks: u32) -> usize {
        let mut n = 0;
        let mut buf = CommandBuf::new();
        for _ in 0..ticks {
            w.mana[1] = mana << 16;
            buf.clear();
            step(w, &mut buf);
            n += buf
                .as_slice()
                .iter()
                .filter(|c| c.verb == VERB_EARTHQUAKE || c.verb == VERB_VOLCANO)
                .count();
            w.tick = w.tick.wrapping_add(1);
        }
        n
    }

    #[test]
    fn strikes_wait_for_their_wave_and_never_overdraw_the_reserve() {
        let mut w = ai_world();
        w.cfg.ai_level = [LEVEL_EASY; PLAYERS];
        after_waves(&mut w, 1);
        assert_eq!(
            strikes(&mut w, 9_999, 2_000),
            0,
            "an easy opponent struck before the second wave"
        );
        after_waves(&mut w, 2);
        assert_eq!(strikes(&mut w, 0, 2_000), 0, "a broke opponent still paid for a strike");
        assert!(strikes(&mut w, 9_999, 2_000) > 0, "a rich opponent never strikes");
    }

    #[test]
    fn strikes_are_spaced() {
        // After the first wave, not the second: on this map the fair-spawn
        // pass sank the richer side's outer land below the last wave's line,
        // so after the second wave there is nothing left worth striking.
        let mut w = ai_world();
        after_waves(&mut w, 1);
        let t = tuning(LEVEL_NORMAL, STYLE_BALANCED);
        let n = strikes(&mut w, 9_999, t.strike_gap * 3);
        assert!((1..=4).contains(&n), "{n} strikes in three strike gaps");
    }

    #[test]
    fn a_rush_opponent_marches_on_the_enemy() {
        let mut w = ai_world();
        w.cfg.ai_style = [STYLE_RUSH; PLAYERS];
        let mut marched = false;
        for _ in 0..3_000 {
            w.tick(&[]);
            if w.magnet[1].active == 0 {
                continue;
            }
            marched |= w.settlements.iter().any(|s| {
                s.alive()
                    && s.owner == 0
                    && (s.face, s.x, s.y) == (w.magnet[1].face, w.magnet[1].x, w.magnet[1].y)
            });
            if marched {
                break;
            }
        }
        assert!(marched, "a rush opponent never sent the army at the enemy");
    }

    #[test]
    fn a_rush_with_no_land_to_march_on_buys_no_champions() {
        // The shipped archipelago: no land joins the spawns. After the first
        // magnet shows there is no path, not one champion is bought.
        let mut cfg = MapConfig::DEFAULT;
        cfg.ai_enabled = 1;
        cfg.ai_style = [STYLE_RUSH; PLAYERS];
        let mut w = World::boxed();
        w.init(&cfg);
        let mut champions = 0;
        for _ in 0..6_000 {
            w.mana[1] = 9_999 << 16;
            let mut buf = CommandBuf::new();
            let saved = w.ai;
            step(&mut w, &mut buf);
            w.ai = saved;
            champions += buf.as_slice().iter().filter(|c| c.verb == VERB_CHAMPION).count();
            w.tick(&[]);
        }
        let (f, x, y) = crate::settlements::STARTS[1];
        assert!(
            w.dist[1][idx(f, x, y)] >= crate::flowfield::FALLBACK_BASE,
            "this map was supposed to have no land path"
        );
        assert!(champions <= 1, "a stranded rush bought {champions} champions");
    }

    #[test]
    fn the_opponent_does_not_level_its_own_economy_in_the_opening() {
        // Seed 0x9E37D8A6, shipped map, nobody at the other controls: the old
        // curriculum's first thrown raise razed four of the opponent's seven
        // settlements, and an idle player won by sudden death at tick 691.
        for level in 0..LEVEL_COUNT {
            let mut cfg = MapConfig::DEFAULT;
            cfg.ai_enabled = 1;
            cfg.ai_level = [level; PLAYERS];
            cfg.seed = 0x9E37_D8A6;
            let mut w = World::boxed();
            w.init(&cfg);
            for _ in 0..1_500 {
                w.tick(&[]);
            }
            assert_ne!(w.outcome, 1, "level {level} lost to an idle player in the opening");
            let towns =
                w.settlements.iter().filter(|s| s.alive() && s.owner == 1 && s.tier > 0).count();
            assert!(towns >= 3, "level {level} has {towns} standing towns after its opening");
        }
    }

    #[test]
    fn the_opponent_lifts_its_land_above_the_coming_wave() {
        // The whole point of the terraforming: more of its own land clears the
        // next peak after a few minutes of play than at the start.
        let mut cfg = MapConfig::DEFAULT;
        cfg.ai_enabled = 1;
        cfg.seed = 0x5EED;
        let mut w = World::boxed();
        w.init(&cfg);
        for _ in 0..30 {
            w.tick(&[]);
        }
        let line = waterline(&w);
        let before = held_above(&w, line)[1];
        for _ in 0..2_400 {
            w.tick(&[]);
        }
        let after = held_above(&w, line)[1];
        assert!(after > before, "the opponent held {before} cells above the line, then {after}");
    }

    #[test]
    fn every_tuning_is_well_formed() {
        for level in 0..=LEVEL_COUNT {
            for style in 0..=STYLE_COUNT {
                let t = tuning(level, style);
                assert!(t.think > 0 && t.hold > 1 && t.strike_gap > 0 && t.reserve >= 0);
            }
        }
        // Better levels think faster.
        assert!(tuning(LEVEL_HARD, 0).think < tuning(LEVEL_NORMAL, 0).think);
        assert!(tuning(LEVEL_NORMAL, 0).think < tuning(LEVEL_EASY, 0).think);
    }
}
