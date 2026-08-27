//! The tide cycle. HANDOFF §5.5.
//!
//! **The tides are a world property, not the mode.** They are not the boss
//! (pillar 5). They do three jobs: keep habitable land finite so influence stays
//! zero-sum, periodically erase fortifications so entrenchment is never
//! permanent, and — the important one — compress the habitable band until
//! contact between the two peoples is unavoidable rather than optional.
//!
//! # Telegraphing without UI
//!
//! §5.5 requires the wave to be visible before it lands, and §8 forbids a HUD.
//! The telegraph is therefore the sea itself: during the warning phase the
//! global sea level **drops below baseline**, so water visibly draws back off
//! every shore at once. It is the real-world tell, it is legible from any camera
//! angle, and it costs one signed integer.

use crate::world::{
    MAX_WAVES, N, PLAYERS, TIDE_CALM, TIDE_DONE, TIDE_IMPACT, TIDE_RECOVERY, TIDE_TELEGRAPH, World,
    idx,
};

/// How far the sea draws back during the telegraph, as a fraction of the wave's
/// peak. `[START]` a third: enough to be unmistakable, not so much that the
/// retreat itself becomes the disaster.
pub const DRAWBACK_NUMERATOR: i32 = 1;
pub const DRAWBACK_DENOMINATOR: i32 = 3;

/// Advance the tide by one tick.
pub fn step(w: &mut World) {
    if w.tide.phase == TIDE_DONE {
        w.sea_level = w.sea_base;
        return;
    }
    if w.cfg.waves == 0 {
        w.tide.phase = TIDE_DONE;
        w.sea_level = w.sea_base;
        return;
    }

    if w.tide.strength == 0 {
        w.tide.strength = wave_strength(w, 0);
    }

    let cfg = w.cfg;
    w.tide.timer = w.tide.timer.wrapping_add(1);

    match w.tide.phase {
        TIDE_CALM => {
            w.tide.offset = 0;
            // The opening lull, not a recovery: nothing has happened yet, so
            // there is nothing to recover from. See `MapConfig::lull_ticks`.
            if w.tide.timer >= cfg.lull_ticks {
                enter(w, TIDE_TELEGRAPH);
            }
        }
        TIDE_TELEGRAPH => {
            // Sea level slides down to the drawback depth over the whole warning.
            let peak = i32::from(w.tide.strength);
            let low = -peak * DRAWBACK_NUMERATOR / DRAWBACK_DENOMINATOR;
            let t = w.tide.timer.min(cfg.telegraph_ticks) as i32;
            let span = cfg.telegraph_ticks.max(1) as i32;
            w.tide.offset = (low * t / span) as i16;
            if w.tide.timer >= cfg.telegraph_ticks {
                enter(w, TIDE_IMPACT);
            }
        }
        TIDE_IMPACT => {
            // Up to the peak over the first half, back to baseline over the
            // second. The recede is as much of the mechanic as the surge: it is
            // what hands the land back so it can be fought over again.
            let peak = i32::from(w.tide.strength);
            let low = -peak * DRAWBACK_NUMERATOR / DRAWBACK_DENOMINATOR;
            let span = cfg.impact_ticks.max(2) as i32;
            let half = span / 2;
            let t = w.tide.timer.min(cfg.impact_ticks) as i32;
            w.tide.offset = if t <= half {
                (low + (peak - low) * t / half.max(1)) as i16
            } else {
                (peak - peak * (t - half) / (span - half).max(1)) as i16
            };

            // Score at wave peak (§5.5).
            if t == half && w.tide.scored == 0 {
                w.tide.scored = 1;
                score_wave(w);
            }

            if w.tide.timer >= cfg.impact_ticks {
                enter(w, TIDE_RECOVERY);
            }
        }
        _ => {
            w.tide.offset = 0;
            // After the last wave there is nothing left to rebuild for, so the
            // match closes on the short lull rather than sitting through a full
            // recovery window with its result already determined.
            let last = w.tide.wave.saturating_add(1) >= cfg.waves;
            if w.tide.timer >= if last { cfg.lull_ticks } else { cfg.recovery_ticks } {
                let next = w.tide.wave.saturating_add(1);
                if next >= cfg.waves {
                    w.tide.phase = TIDE_DONE;
                    w.tide.offset = 0;
                    decide_match(w);
                } else {
                    w.tide.wave = next;
                    w.tide.strength = wave_strength(w, next);
                    w.tide.scored = 0;
                    enter(w, TIDE_TELEGRAPH);
                }
            }
        }
    }

    w.sea_level = w.sea_base.saturating_add(w.tide.offset);
    check_sudden_death(w);
}

fn enter(w: &mut World, phase: u8) {
    w.tide.phase = phase;
    w.tide.timer = 0;
}

/// Wave `i`'s peak, escalating by `escalation` percent per wave (§5.4).
#[must_use]
pub fn wave_strength(w: &World, wave: u8) -> i16 {
    let mut s = i64::from(w.cfg.wave_strength);
    for _ in 0..wave {
        s = s * i64::from(w.cfg.escalation) / 100;
    }
    s.clamp(0, i64::from(i16::MAX) / 2) as i16
}

/// Armageddon: immediately triggers the final tide wave at maximum strength
/// (§5.1). The stalemate breaker, and deliberately awkward to invoke (§8).
pub fn trigger_armageddon(w: &mut World) {
    if w.tide.phase == TIDE_DONE {
        return;
    }
    let last = w.cfg.waves.saturating_sub(1);
    w.tide.wave = last;
    w.tide.strength = wave_strength(w, last).saturating_mul(2);
    w.tide.scored = 0;
    enter(w, TIDE_TELEGRAPH);
}

/// Score per wave = habitable cells under own influence, sampled at wave peak.
fn score_wave(w: &mut World) {
    let mut held = [0u32; PLAYERS];
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let c = idx(face, x, y);
                if !w.habitable(c) {
                    continue;
                }
                let infl = i32::from(w.influence[c]);
                if infl > 0 {
                    held[0] += 1;
                } else if infl < 0 {
                    held[1] += 1;
                }
            }
        }
    }
    let wave = (w.tide.wave as usize).min(MAX_WAVES - 1);
    for p in 0..PLAYERS {
        w.score[p][wave] = held[p].min(u32::from(u16::MAX)) as u16;
    }
}

/// Sudden death: influence reaching 0 is an immediate loss, whatever the score
/// (§5.5).
fn check_sudden_death(w: &mut World) {
    if w.outcome != 0 {
        return;
    }
    let mut held = [0u32; PLAYERS];
    for face in 0..6usize {
        for y in 0..N {
            for x in 0..N {
                let infl = i32::from(w.influence[idx(face, x, y)]);
                if infl > 0 {
                    held[0] += 1;
                } else if infl < 0 {
                    held[1] += 1;
                }
            }
        }
    }
    match (held[0], held[1]) {
        (0, 0) => w.outcome = 3,
        (0, _) => w.outcome = 2,
        (_, 0) => w.outcome = 1,
        _ => {}
    }
}

/// Most waves won takes the match (§5.5).
fn decide_match(w: &mut World) {
    if w.outcome != 0 {
        return;
    }
    let mut wins = [0u32; PLAYERS];
    for wave in 0..(w.cfg.waves as usize).min(MAX_WAVES) {
        let a = w.score[0][wave];
        let b = w.score[1][wave];
        if a > b {
            wins[0] += 1;
        } else if b > a {
            wins[1] += 1;
        }
    }
    w.outcome = if wins[0] > wins[1] {
        1
    } else if wins[1] > wins[0] {
        2
    } else {
        3
    };
}

/// Ticks until the current wave makes landfall, for the renderer's swell.
///
/// Exposed as data rather than drawn as a bar: the renderer turns it into a
/// swell height and a horizon tint, and §8 stays intact.
#[must_use]
pub fn ticks_to_impact(w: &World) -> u32 {
    match w.tide.phase {
        // The opening window is the lull, not a recovery — and the closing one
        // is too, but there is no wave after it, so the number it produces is
        // never read for anything but a sky that is about to stop mattering.
        TIDE_CALM => w.cfg.lull_ticks.saturating_sub(w.tide.timer) + w.cfg.telegraph_ticks,
        TIDE_TELEGRAPH => w.cfg.telegraph_ticks.saturating_sub(w.tide.timer),
        TIDE_IMPACT => 0,
        _ => {
            let last = w.tide.wave.saturating_add(1) >= w.cfg.waves;
            let wait = if last { w.cfg.lull_ticks } else { w.cfg.recovery_ticks };
            wait.saturating_sub(w.tide.timer) + w.cfg.telegraph_ticks
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MapConfig, TERRAIN_PANGAEA};

    fn tidal_world() -> alloc::boxed::Box<World> {
        let mut cfg = MapConfig::DEFAULT;
        cfg.terrain = TERRAIN_PANGAEA;
        cfg.telegraph_ticks = 30;
        cfg.impact_ticks = 20;
        cfg.recovery_ticks = 40;
        cfg.lull_ticks = 25;
        cfg.waves = 3;
        cfg.wave_strength = 90;
        cfg.escalation = 200;
        let mut w = World::boxed();
        w.init(&cfg);
        w
    }

    #[test]
    fn the_sea_draws_back_before_it_surges() {
        let mut w = tidal_world();
        let mut min_offset = 0i16;
        let mut max_offset = 0i16;
        let mut saw_drawback_before_surge = false;
        for _ in 0..200 {
            step(&mut w);
            min_offset = min_offset.min(w.tide.offset);
            max_offset = max_offset.max(w.tide.offset);
            if min_offset < 0 && max_offset == 0 {
                saw_drawback_before_surge = true;
            }
            if max_offset > 0 {
                break;
            }
        }
        assert!(saw_drawback_before_surge, "the sea surged with no warning");
        assert!(min_offset < 0, "there was no drawback at all");
        assert!(max_offset > 0, "the wave never landed");
    }

    #[test]
    fn the_telegraph_is_long_enough_to_react_to() {
        // Pillar 2: input is loosely coupled to response, so the warning has to
        // be measured in seconds, not frames. The spec's `[START]` is 300 ticks.
        let cfg = MapConfig::DEFAULT;
        assert!(
            cfg.telegraph_ticks >= 150,
            "a {}-tick telegraph is {} s — not enough to reshape anything",
            cfg.telegraph_ticks,
            cfg.telegraph_ticks / 30
        );
    }

    #[test]
    fn waves_escalate_and_the_cycle_completes() {
        let mut w = tidal_world();
        let s0 = wave_strength(&w, 0);
        let s1 = wave_strength(&w, 1);
        let s2 = wave_strength(&w, 2);
        assert!(s1 > s0 && s2 > s1, "waves do not escalate: {s0}, {s1}, {s2}");

        let mut ticks = 0;
        while w.tide.phase != TIDE_DONE && ticks < 100_000 {
            step(&mut w);
            ticks += 1;
        }
        assert_eq!(w.tide.phase, TIDE_DONE, "the tide cycle never finished");
        assert_eq!(w.tide.wave as usize, w.cfg.waves as usize - 1);
        assert_ne!(w.outcome, 0, "the match ended with no result");
    }

    #[test]
    fn sea_level_returns_to_baseline_between_waves() {
        let mut w = tidal_world();
        let mut saw_recovery = false;
        for _ in 0..400 {
            step(&mut w);
            if w.tide.phase == TIDE_RECOVERY {
                assert_eq!(w.tide.offset, 0, "recovery is not calm");
                assert_eq!(w.sea_level, w.sea_base);
                saw_recovery = true;
            }
        }
        assert!(saw_recovery, "never reached a recovery window");
    }

    #[test]
    fn the_flood_power_moves_the_baseline_and_the_tide_rides_on_top() {
        let mut w = tidal_world();
        w.sea_base = 200;
        for _ in 0..60 {
            step(&mut w);
        }
        assert_eq!(w.sea_level, 200 + w.tide.offset, "tide and flood do not compose");
    }

    #[test]
    fn armageddon_jumps_straight_to_the_final_wave_at_double_strength() {
        let mut w = tidal_world();
        let natural_last = wave_strength(&w, w.cfg.waves - 1);
        trigger_armageddon(&mut w);
        assert_eq!(w.tide.phase, TIDE_TELEGRAPH, "armageddon skipped the warning");
        assert_eq!(w.tide.wave, w.cfg.waves - 1);
        assert!(w.tide.strength > natural_last, "armageddon is not the strongest wave");
    }

    #[test]
    fn a_wave_lands_every_fifteen_minutes() {
        // User decision, superseding §5.5's 45-second `[START]`: the cadence is
        // a wave every fifteen minutes. The cadence *is* the wave cycle —
        // telegraph, impact, recovery — because the next telegraph begins the
        // moment the last recovery ends.
        let cfg = MapConfig::DEFAULT;
        let cadence = cfg.telegraph_ticks + cfg.impact_ticks + cfg.recovery_ticks;
        assert_eq!(cadence, 15 * 60 * 30, "a wave every {} s, not 900", cadence / 30);
    }

    #[test]
    fn the_lulls_do_not_add_a_dead_quarter_hour_at_each_end() {
        // The whole reason `lull_ticks` exists. Running the opening and closing
        // windows on `recovery_ticks` would put fourteen minutes of nothing
        // before the first telegraph and another fourteen after the last wave
        // had already decided the match.
        let cfg = MapConfig::DEFAULT;
        assert!(
            cfg.lull_ticks * 4 < cfg.recovery_ticks,
            "a {}-second lull is not short against a {}-second recovery",
            cfg.lull_ticks / 30,
            cfg.recovery_ticks / 30
        );
    }

    #[test]
    fn a_match_is_roughly_the_target_length() {
        // Three waves at the fifteen-minute cadence, plus a lull at each end.
        let cfg = MapConfig::DEFAULT;
        let per_wave = cfg.telegraph_ticks + cfg.impact_ticks + cfg.recovery_ticks;
        // The last wave closes on a lull rather than a full recovery, so the
        // final recovery is refunded.
        let total = per_wave * u32::from(cfg.waves) - cfg.recovery_ticks + cfg.lull_ticks * 2;
        let minutes = total / 30 / 60;
        assert!(
            (25..=45).contains(&minutes),
            "a full cycle is {minutes} minutes; three waves fifteen minutes apart is ~34"
        );
    }

    #[test]
    fn losing_all_influence_ends_the_match_immediately() {
        let mut w = tidal_world();
        for c in 0..w.influence.len() {
            w.influence[c] = 0;
        }
        for face in 0..6usize {
            for y in 0..N {
                for x in 0..N {
                    w.influence[idx(face, x, y)] = 40; // player 0 holds everything
                }
            }
        }
        step(&mut w);
        assert_eq!(w.outcome, 1, "a wipe-out did not end the match");
    }

    #[test]
    fn ticks_to_impact_counts_down_monotonically_within_a_phase() {
        let mut w = tidal_world();
        while w.tide.phase != TIDE_TELEGRAPH {
            step(&mut w);
        }
        let mut last = ticks_to_impact(&w);
        while w.tide.phase == TIDE_TELEGRAPH {
            step(&mut w);
            if w.tide.phase != TIDE_TELEGRAPH {
                break;
            }
            let now = ticks_to_impact(&w);
            assert!(now <= last, "the countdown went backwards: {last} -> {now}");
            last = now;
        }
    }
}
