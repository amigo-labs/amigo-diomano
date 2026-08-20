# diomano

> `dio` + `mano` — the god and the hand, which is the entire interface.
> Reads Italian rather than Spanish; deliberate, not a typo.

Browser-based 1v1 god game on a spherical planet. Indirect control only: the
player reshapes terrain and the population acts autonomously, including fighting
the opposing population on contact.

`docs/HANDOFF.md` is the specification. `docs/specs/*.md` split it by area and
carry the values that have since been measured. `PLAN.md` says where the work is.

## Quick start

```sh
just check          # cargo test + clippy + biome + tsc, zero warnings
just dev            # build the wasm, serve the client on :5173
just verify-cross   # native vs headless browser determinism — the important one
just perf           # per-pass ms breakdown against the 12 ms budget
```

Requires `rustup` (with the `wasm32-unknown-unknown` target), `bun`, `just` and
`node`. `bun install` in `web/` brings the rest, including `wasm-opt`.

## Layout

```
crates/diomano-sim/    the entire simulation. no_std, integer-only, no dependencies
crates/diomano-wasm/   thin extern "C" shell. exports and pointer getters only
crates/diomano-cli/    native replay verifier and perf harness
web/                   Three.js renderer, camera, hand, gestures, audio
fixtures/              a recorded session and the hashes it must produce
```

`diomano-sim` knows nothing about WebAssembly, the browser or Three.js. It
compiles to `wasm32-unknown-unknown` behind the shell and to a native binary for
the verifier, **from the same source**. That split is the only reason
determinism is verifiable rather than merely intended, so it must not be
collapsed.

## Controls

No HUD. The hand is the entire interface — cursor, matter carrier and mana
indicator in one. It visibly fills as you dig and empties as you build, because
material is conserved and a full hand cannot dig.

| Input | Verb |
|---|---|
| left drag up / down | raise / lower land |
| left click | place the papal magnet — the only command in the game |
| `1` `2` `3` | carry earth / water / lava |
| middle or right drag | orbit the planet |
| right drag, spiral, then a shape | flood `~`, volcano `∧`, swamp `∪`, earthquake `Z`, champion `+` |
| shift / alt / ctrl while dragging | thrown / increased / extreme |

## What is not here

No netcode. Phase 7 is deliberately unbuilt: no WebRTC, no lockstep, no command
frames on a wire, no Durable Objects. The simulation already advances by
`tick(commands: &[Command])` and nothing else, so netcode is later a transport
concern — and `just verify-cross` is the evidence that it will be worth starting.

`PLAN.md` lists everything else that is missing, and the seven places where the
specification needed a decision. `docs/balance-research.md` records what the
originals can and cannot tell us — the short version being that the numbers were
never published, so every `[START]` has to be playtested rather than sourced.

## Licence

MIT. Shaders, geometry and audio are procedural; the only third-party assets
are five CC0 surface textures from ambientCG (public domain, no attribution
required) — provenance in `docs/ASSETS.md`, per HANDOFF §7.5's "CC0 only"
clause.
