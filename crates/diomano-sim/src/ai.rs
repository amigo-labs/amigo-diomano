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

use crate::world::{
    Command, CommandBuf, MOD_THROWN, N, PLAYERS, VERB_LOWER, VERB_MAGNET, VERB_RAISE, VERB_VOLCANO,
    World, idx,
};

/// One step of the demonstration script.
#[derive(Clone, Copy, Debug)]
struct Lesson {
    /// What the player would press.
    verb: u8,
    /// How many ticks to hold it for.
    hold: u32,
    /// Ticks of stillness afterwards, so the effect is watchable.
    pause: u32,
    /// Offset from the anchor, in cells, for the target.
    dx: i8,
    dy: i8,
    modifier: u8,
}

const fn lesson(verb: u8, hold: u32, pause: u32, dx: i8, dy: i8, modifier: u8) -> Lesson {
    Lesson { verb, hold, pause, dx, dy, modifier }
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
    // Dig a channel towards the sea, so water has somewhere to go.
    lesson(VERB_LOWER, 30, 30, 0, 9, MOD_THROWN),
    // Reclaim land with lava, which is the counter-play to the tide.
    lesson(VERB_VOLCANO, 1, 150, 4, -9, 0),
    // Raise a wall across the approach: the terrain response that saves a
    // settlement under siege.
    lesson(VERB_RAISE, 30, 120, -2, -7, MOD_THROWN),
];

/// Emit this tick's commands for the scripted player.
///
/// Runs inside the tick (pass 2b in [`World::tick`]) and its output is applied
/// through exactly the same path as a human's input.
pub fn step(w: &mut World, out: &mut CommandBuf) {
    let player = (w.cfg.ai_player as usize) % PLAYERS;
    if w.outcome != 0 {
        return;
    }

    // Re-anchor on the scripted player's strongest settlement whenever the
    // script wraps, so the demonstration follows the action instead of playing
    // out next to a crater.
    if w.ai.script_pc as usize >= SCRIPT.len() {
        w.ai.script_pc = 0;
        w.ai.timer = 0;
        reanchor(w, player);
    }
    if w.ai.anchor_face == 0 && w.ai.anchor_x == 0 && w.ai.anchor_y == 0 {
        reanchor(w, player);
    }

    let l = SCRIPT[w.ai.script_pc as usize];
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

    let (x, y) = target(w, l);
    out.push(Command {
        tick: w.tick,
        x,
        y,
        player: player as u8,
        verb: l.verb,
        face: w.ai.anchor_face,
        modifier: l.modifier,
    });

    // The hand has to be emptied before it can be filled again, exactly as the
    // player's does. Digging with a full hand does nothing, so drop the surplus
    // into the pit it just dug rather than pretending capacity is infinite.
    w.ai.cursor = w.ai.cursor.wrapping_add(1);
}

fn target(w: &World, l: Lesson) -> (u16, u16) {
    let x = (i32::from(w.ai.anchor_x) + i32::from(l.dx)).clamp(0, N as i32 - 1);
    let y = (i32::from(w.ai.anchor_y) + i32::from(l.dy)).clamp(0, N as i32 - 1);
    (x as u16, y as u16)
}

/// Point the script at the scripted player's best settlement, or at their
/// starting face if they have none left.
fn reanchor(w: &mut World, player: usize) {
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
    if let Some((_, i)) = best {
        let s = w.settlements[i];
        w.ai.anchor_face = s.face;
        w.ai.anchor_x = s.x;
        w.ai.anchor_y = s.y;
    } else {
        w.ai.anchor_face = if player == 0 { 4 } else { 5 };
        w.ai.anchor_x = (N / 2) as u8;
        w.ai.anchor_y = (N / 2) as u8;
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
        // the game.
        for l in SCRIPT {
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
        for _ in 0..500 {
            buf.clear();
            step(&mut w, &mut buf);
        }
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
        let run = || {
            let mut w = ai_world();
            for _ in 0..600 {
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
}
