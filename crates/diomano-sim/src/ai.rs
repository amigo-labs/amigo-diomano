//! A scripted opponent.
//!
//! Not in the HANDOFF plan; requested for this run as a stand-in for the second
//! god until netcode exists. Its brief is narrow and worth stating, because it
//! is the reason it is a *script* and not a planner:
//!
//! > it visibly performs the same verbs the player has, so the player learns
//! > them by watching.
//!
//! Two consequences follow, and both are load-bearing:
//!
//! - It emits [`Command`]s and nothing else. It has no privileged mutation path
//!   into the world, so anything it does, the player can do — and pillar 3 holds
//!   for it as much as for a human (it never issues an attack order, because
//!   there is no such verb to issue).
//! - It acts slowly and one lesson at a time. A competent opponent would
//!   interleave everything and teach nothing.
//!
//! It is fully deterministic: its only inputs are world state and tick count.
//! Both peers running it would agree, so it survives the netcode phase unchanged.
//!
//! It teaches once, then it fights. After a single pass through the curriculum
//! the script switches to [`WAR_SCRIPT`]: grow the economy, march the army at
//! the enemy's strongest settlement, strike it when affordable, wall up when
//! the tide telegraphs. Still only ordinary commands — a war of terraforming
//! and marching, which is the only war this game has.

use crate::world::{
    Command, CommandBuf, MOD_THROWN, PLAYERS, TIDE_TELEGRAPH, VERB_EARTHQUAKE, VERB_LOWER,
    VERB_MAGNET, VERB_RAISE, VERB_VOLCANO, World, idx, verb_power,
};

/// `AiState::phase` value once the curriculum has been shown once.
pub const PHASE_WAR: u8 = 1;

/// Mana the war phase keeps in hand before it pays for a strike, so it can
/// always afford the next magnet and never bankrupts its own march.
const WAR_RESERVE: i32 = 200;

/// Where a move points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Aim {
    /// The scripted player's own anchor settlement, plus the move's offset.
    Home,
    /// The *enemy's* strongest settlement, plus the move's offset.
    EnemyBase,
}

/// One step of a script — a lesson in the curriculum, a move in the war.
#[derive(Clone, Copy, Debug)]
struct Lesson {
    /// What the player would press.
    verb: u8,
    /// How many ticks to hold it for.
    hold: u32,
    /// Ticks of stillness afterwards, so the effect is watchable.
    pause: u32,
    /// Offset from the aim point, in cells, for the target.
    dx: i8,
    dy: i8,
    modifier: u8,
    aim: Aim,
    /// Emit only while `mana >= cost + WAR_RESERVE` — the strike gate.
    needs_reserve: bool,
    /// Emit only during a tide telegraph — the defensive-wall gate.
    telegraph_only: bool,
}

const fn lesson(verb: u8, hold: u32, pause: u32, dx: i8, dy: i8, modifier: u8) -> Lesson {
    Lesson {
        verb,
        hold,
        pause,
        dx,
        dy,
        modifier,
        aim: Aim::Home,
        needs_reserve: false,
        telegraph_only: false,
    }
}

#[expect(clippy::too_many_arguments, reason = "a const table row, not an API")]
const fn war_move(
    verb: u8,
    hold: u32,
    pause: u32,
    dx: i8,
    dy: i8,
    modifier: u8,
    aim: Aim,
    needs_reserve: bool,
    telegraph_only: bool,
) -> Lesson {
    Lesson { verb, hold, pause, dx, dy, modifier, aim, needs_reserve, telegraph_only }
}

/// The curriculum, in order. Each pass through it is one visible "turn".
///
/// Deliberately opens with dig-then-build: matter conservation (pillar 4) is the
/// least obvious rule in the game and the easiest to show — the hand fills, then
/// it empties.
const SCRIPT: &[Lesson] = &[
    // Dig a pit next door. The hand visibly fills.
    lesson(VERB_LOWER, 24, 20, 8, 0, 0),
    // Spend it flattening ground beside home. The hand visibly empties, and a
    // settlement appears on the plateau a few seconds later with no order given.
    lesson(VERB_RAISE, 24, 90, -6, 0, MOD_THROWN),
    // Move the magnet: the only command in the game.
    lesson(VERB_MAGNET, 1, 120, -10, 6, 0),
    // Dig a channel towards the sea, so water has somewhere to go. Southward:
    // the contact corridor approaches every spawn from the north, and the
    // original (0, +9) target dug straight through it — the opponent was
    // severing its own only road to the enemy in its fourth lesson.
    lesson(VERB_LOWER, 30, 30, 0, -9, MOD_THROWN),
    // Reclaim land with lava, which is the counter-play to the tide.
    lesson(VERB_VOLCANO, 1, 150, 4, -9, 0),
    // Raise a wall across the approach: the terrain response that saves a
    // settlement under siege.
    lesson(VERB_RAISE, 30, 120, -2, -7, MOD_THROWN),
];

/// The war, after one pass of teaching. Same interpreter, different table:
/// grow the economy, march the army at the enemy over the causeway, strike
/// the enemy base when affordable, wall up when the sea telegraphs.
///
/// One pass is ~19 s — under a tide cycle — so every wave sees a march. It
/// still emits nothing but ordinary commands: contact and combat resolve
/// autonomously (§4.7), because there is no attack order to issue.
const WAR_SCRIPT: &[Lesson] = &[
    // Refill the hand.
    war_move(VERB_LOWER, 24, 12, 8, 0, 0, Aim::Home, false, false),
    // Flatten ground beside home: settlements found themselves, and they are
    // the economy — influence, mana and walkers all grow from them.
    war_move(VERB_RAISE, 46, 30, -6, 2, MOD_THROWN, Aim::Home, false, false),
    // The march: drop the magnet on the enemy's strongest settlement and give
    // the army a tide cycle's recovery window to walk the causeway.
    war_move(VERB_MAGNET, 1, 300, 0, 0, 0, Aim::EnemyBase, false, false),
    // The strike, when affordable past the reserve. Earthquake, deliberately
    // never volcano: a lava pool on the enemy plateau makes the AI's *own*
    // magnet cell impassable, the flow field falls back, and the army walks
    // home from its own siege — traced, both armies parked for a whole match.
    // Broken ground starves the settlement (§5.2) and blocks nobody.
    war_move(VERB_EARTHQUAKE, 1, 90, 1, -1, 0, Aim::EnemyBase, true, false),
    // The sea is coming: a wall across home's seaward approach.
    war_move(VERB_RAISE, 30, 30, -2, -7, MOD_THROWN, Aim::Home, false, true),
];

/// Emit this tick's commands for the scripted player.
///
/// Runs inside the tick (pass 2b in [`World::tick`]) and its output is applied
/// through exactly the same path as a human's input.
pub fn step(w: &mut World, out: &mut CommandBuf) {
    let player = (w.cfg.ai_player as usize) % PLAYERS;
    // A decided match silences the opponent — except in endless worlds, where
    // the world itself keeps running (the §6.3 corpus) and a mute opponent
    // would halve the coverage of exactly the phase the corpus is there for.
    if w.outcome != 0 && w.cfg.endless == 0 {
        return;
    }

    // Re-anchor on the scripted player's strongest settlement whenever the
    // script wraps, so the demonstration follows the action instead of playing
    // out next to a crater. After one full pass of teaching, the gloves come
    // off: the curriculum hands over to the war table. Both tables are
    // non-empty, so this settles in at most two rounds.
    loop {
        if (w.ai.script_pc as usize) < current_script(w).len() {
            break;
        }
        w.ai.script_pc = 0;
        w.ai.timer = 0;
        w.ai.repeat = w.ai.repeat.wrapping_add(1);
        if w.ai.phase != PHASE_WAR && w.ai.repeat >= 1 {
            w.ai.phase = PHASE_WAR;
            w.ai.repeat = 0;
        }
        reanchor(w, player);
    }
    if w.ai.anchor_face == 0 && w.ai.anchor_x == 0 && w.ai.anchor_y == 0 {
        reanchor(w, player);
    }

    let l = current_script(w)[w.ai.script_pc as usize];
    let t = w.ai.timer;
    w.ai.timer = t.wrapping_add(1);
    if t >= l.hold + l.pause {
        w.ai.script_pc = w.ai.script_pc.wrapping_add(1);
        w.ai.timer = 0;
        return;
    }
    if t >= l.hold {
        return; // the pause: stand back and let the world respond
    }

    // A wall is only worth raising while the sea telegraphs; on a calm tick
    // the whole move is skipped rather than half-held.
    if l.telegraph_only && w.tide.phase != TIDE_TELEGRAPH {
        if t == 0 {
            w.ai.script_pc = w.ai.script_pc.wrapping_add(1);
            w.ai.timer = 0;
        }
        return;
    }

    // The reserve gate: never spend down past the next magnet. Emitting
    // nothing this tick is fine — the timer still advances, so an unaffordable
    // strike is a skipped beat and not a stall.
    let verb = l.verb;
    if l.needs_reserve {
        let cost = verb_power(verb).map_or(0, |p| i32::from(w.cfg.power_cost[p]));
        if w.mana_units(player) < cost + WAR_RESERVE {
            return;
        }
    }

    // `target` has nothing only for an anchor that is itself off its face, which
    // `reanchor` never produces; skipping the beat is the honest fallback.
    let Some((face, x, y)) = target(w, player, l) else {
        return;
    };
    out.push(Command {
        tick: w.tick,
        x,
        y,
        player: player as u8,
        verb,
        face,
        modifier: l.modifier,
    });
}

fn current_script(w: &World) -> &'static [Lesson] {
    if w.ai.phase == PHASE_WAR { WAR_SCRIPT } else { SCRIPT }
}

fn target(w: &World, player: usize, l: Lesson) -> Option<(u8, u16, u16)> {
    let (face, ax, ay) = match l.aim {
        Aim::Home => (w.ai.anchor_face, w.ai.anchor_x, w.ai.anchor_y),
        Aim::EnemyBase => {
            let enemy = (player + 1) % PLAYERS;
            strongest_settlement(w, enemy).unwrap_or_else(|| {
                let (f, x, y) = crate::settlements::STARTS[enemy];
                (f as u8, x as u8, y as u8)
            })
        }
    };
    // The offset walks across seams like everything else on the cube does. It
    // used to clamp to the face instead, so a lesson aimed six cells west of a
    // settlement four cells from the edge landed inside that settlement's own
    // footprint — and the opponent spent the whole hold digging up its own town.
    let (f, x, y) = crate::world::walk(
        face as usize,
        i32::from(ax),
        i32::from(ay),
        i32::from(l.dx),
        i32::from(l.dy),
    )?;
    Some((f as u8, x as u16, y as u16))
}

/// A player's strongest settlement: tier descending, slot ascending — the
/// exact mirror of `reanchor`'s scan, so both gods agree on what "strongest"
/// means.
fn strongest_settlement(w: &World, player: usize) -> Option<(u8, u8, u8)> {
    let mut best: Option<(u8, usize)> = None;
    for (i, s) in w.settlements.iter().enumerate() {
        if !s.alive() || s.owner as usize != player {
            continue;
        }
        match best {
            Some((tier, _)) if s.tier <= tier => {}
            _ => best = Some((s.tier, i)),
        }
    }
    best.map(|(_, i)| {
        let s = w.settlements[i];
        (s.face, s.x, s.y)
    })
}

/// Point the script at the scripted player's best settlement, or at their
/// starting position if they have none left.
fn reanchor(w: &mut World, player: usize) {
    if let Some((face, x, y)) = strongest_settlement(w, player) {
        w.ai.anchor_face = face;
        w.ai.anchor_x = x;
        w.ai.anchor_y = y;
    } else {
        let (face, x, y) = crate::settlements::STARTS[player];
        w.ai.anchor_face = face as u8;
        w.ai.anchor_x = x as u8;
        w.ai.anchor_y = y as u8;
    }
    let _ = idx(w.ai.anchor_face as usize, w.ai.anchor_x as usize, w.ai.anchor_y as usize);
}

/// The full length of one pass through the script, in ticks. Used by tests and
/// by the docs to state how long a "turn" takes.
#[must_use]
pub fn script_ticks() -> u32 {
    SCRIPT.iter().map(|l| l.hold + l.pause).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MapConfig, TERRAIN_PANGAEA, VERB_COUNT, verb_power};

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

    #[test]
    fn the_opponent_only_uses_verbs_the_player_also_has() {
        // The teaching claim is only true if this holds. A verb the AI can use
        // and the player cannot would be a tutorial for something that is not in
        // the game. The war table is held to the same rule: pillar 3 has no
        // phase exemption.
        for l in SCRIPT.iter().chain(WAR_SCRIPT) {
            assert!(l.verb < VERB_COUNT, "unknown verb {} in the script", l.verb);
            assert!(verb_power(l.verb).is_some(), "verb {} is not a player-facing power", l.verb);
        }
    }

    #[test]
    fn the_opponent_never_touches_the_world_directly() {
        // `step` may only write to its own bookkeeping. Anything else would be a
        // privileged mutation path, and pillar 3 would stop being enforceable.
        let mut w = ai_world();
        let mut buf = CommandBuf::new();
        let before = w.state_hash();
        let ai_before = w.ai;
        for _ in 0..500 {
            buf.clear();
            step(&mut w, &mut buf);
        }
        // Its bookkeeping *is* hashed — it decides the commands it emits, and it
        // runs on both peers — so put that back before comparing: what must be
        // untouched is everything else.
        assert_ne!(w.ai, ai_before, "500 steps did not advance the opponent's own state");
        w.ai = ai_before;
        assert_eq!(
            w.state_hash(),
            before,
            "the scripted opponent mutated hashed state instead of emitting commands"
        );
    }

    #[test]
    fn it_actually_emits_commands() {
        let mut w = ai_world();
        let mut emitted = 0usize;
        let mut verbs = std::collections::BTreeSet::new();
        for _ in 0..script_ticks() * 2 {
            let mut buf = CommandBuf::new();
            step(&mut w, &mut buf);
            for c in buf.as_slice() {
                emitted += 1;
                verbs.insert(c.verb);
                assert_eq!(c.player, w.cfg.ai_player);
            }
        }
        assert!(emitted > 50, "the opponent barely acted ({emitted} commands)");
        assert!(verbs.len() >= 4, "the opponent only demonstrated {} verbs", verbs.len());
    }

    #[test]
    fn each_lesson_has_a_pause_long_enough_to_watch() {
        for (i, l) in SCRIPT.iter().enumerate() {
            assert!(
                l.pause >= 20,
                "lesson {i} pauses for {} ticks ({} s) — too fast to read",
                l.pause,
                l.pause / 30
            );
        }
        let seconds = script_ticks() / 30;
        assert!((10..=120).contains(&seconds), "a full turn takes {seconds} s");
    }

    #[test]
    fn it_is_deterministic_across_runs() {
        let run = || {
            let mut w = ai_world();
            let mut acc = std::vec::Vec::new();
            for _ in 0..1200 {
                let mut buf = CommandBuf::new();
                step(&mut w, &mut buf);
                acc.extend_from_slice(buf.as_slice());
            }
            acc
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn a_full_tick_loop_with_the_opponent_enabled_stays_reproducible() {
        // Long enough to cross the tutorial→war transition, so the war phase
        // is covered by the same reproducibility guarantee.
        let ticks = script_ticks() + 600;
        let run = || {
            let mut w = ai_world();
            for _ in 0..ticks {
                w.tick(&[]);
            }
            w.state_hash()
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn the_anchor_follows_the_opponents_best_settlement() {
        let mut w = ai_world();
        let mut buf = CommandBuf::new();
        step(&mut w, &mut buf);
        assert_eq!(w.ai.anchor_face, w.settlements[1].face);
        assert_eq!(w.ai.anchor_x, w.settlements[1].x);
    }

    /// Steps to drive `step` through one full curriculum pass and into the
    /// wrap check: each lesson costs `hold + pause` ticks plus one advancing
    /// call, plus one call to trigger the wrap itself.
    fn one_pass_steps() -> u32 {
        script_ticks() + SCRIPT.len() as u32 + 1
    }

    #[test]
    fn after_one_curriculum_pass_the_opponent_goes_to_war() {
        let mut w = ai_world();
        let mut buf = CommandBuf::new();
        for _ in 0..one_pass_steps() {
            buf.clear();
            step(&mut w, &mut buf);
        }
        assert_eq!(w.ai.phase, PHASE_WAR, "the opponent is still stuck in the tutorial");
    }

    #[test]
    fn the_war_phase_marches_on_the_enemy() {
        // Full tick loop: the magnet command has to travel the real path
        // (pass 2b → apply_commands) to move the magnet. The enemy is player
        // 0, whose settlements live around STARTS[0].
        let mut w = ai_world();
        let mut marched = false;
        for _ in 0..script_ticks() + 1200 {
            w.tick(&[]);
            if w.magnet[1].active == 0 {
                continue;
            }
            let on_enemy = w.settlements.iter().any(|s| {
                s.alive()
                    && s.owner == 0
                    && s.face == w.magnet[1].face
                    && s.x == w.magnet[1].x
                    && s.y == w.magnet[1].y
            });
            if on_enemy {
                marched = true;
                break;
            }
        }
        assert!(marched, "the war phase never sent the army at the enemy");
    }

    #[test]
    fn a_lesson_aimed_past_the_face_edge_crosses_the_seam_instead_of_clamping() {
        let mut w = ai_world();
        w.ai.anchor_face = 4;
        w.ai.anchor_x = 2;
        w.ai.anchor_y = 30;
        let l = lesson(VERB_RAISE, 1, 0, -6, 2, 0);
        let (face, x, y) = target(&w, 1, l).expect("an anchor on its face always has a target");
        let walked = crate::world::walk(4, 2, 30, -6, 2).expect("the anchor is on the face");
        assert_eq!((face as usize, x as usize, y as usize), walked);
        assert_ne!(
            face, 4,
            "six cells west of x = 2 is on the neighbouring face, not clamped to x = 0"
        );
    }

    #[test]
    fn the_war_phase_never_overdraws_its_reserve() {
        // Drive `step` directly with mana pinned at zero: past the tutorial,
        // no strike may be emitted at all — the reserve gate holds.
        let mut w = ai_world();
        let mut buf = CommandBuf::new();
        for _ in 0..one_pass_steps() {
            buf.clear();
            step(&mut w, &mut buf);
        }
        assert_eq!(w.ai.phase, PHASE_WAR);
        for _ in 0..2000 {
            w.mana[1] = 0;
            buf.clear();
            step(&mut w, &mut buf);
            for c in buf.as_slice() {
                assert!(
                    c.verb != VERB_VOLCANO && c.verb != VERB_EARTHQUAKE,
                    "a broke opponent still paid for a strike"
                );
            }
        }
        // And with a full purse the strike does happen.
        let mut struck = false;
        for _ in 0..2000 {
            w.mana[1] = 9_999 << 16;
            buf.clear();
            step(&mut w, &mut buf);
            if buf.as_slice().iter().any(|c| c.verb == VERB_VOLCANO || c.verb == VERB_EARTHQUAKE) {
                struck = true;
                break;
            }
        }
        assert!(struck, "a rich opponent never strikes");
    }
}
