# diomano — task runner.
#
# `just check` is the gate: it is what CI runs and what must be green before a
# phase is called done (HANDOFF Phase 0 DoD).

set shell := ["bash", "-uc"]

wasm_out := "web/public/diomano.wasm"
wasm_raw := "target/wasm32-unknown-unknown/release/diomano_wasm.wasm"

# `wasm-opt` needs every feature rustc emits for wasm32, not just bulk-memory:
# without `nontrapping-float-to-int` it rejects the mesher's float-to-int casts.
wasm_features := "--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals --enable-multivalue --enable-reference-types --enable-extended-const"

default:
    @just --list

# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------

# Everything CI runs. Zero warnings, all tests green.
check: test lint fmt-check typecheck

test:
    cargo test --workspace

lint:
    cargo clippy --workspace --all-targets -- -D warnings

fmt-check:
    cargo fmt --all -- --check
    ./web/node_modules/.bin/biome check .

typecheck:
    cd web && ./node_modules/.bin/tsc --noEmit

# Format everything in place.
fmt:
    cargo fmt --all
    ./web/node_modules/.bin/biome check --write .

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# Build the wasm module and drop it where the web client expects it.
wasm:
    cargo build --release --target wasm32-unknown-unknown -p diomano-wasm
    mkdir -p web/public
    ./web/node_modules/.bin/wasm-opt -Oz {{wasm_features}} {{wasm_raw}} -o {{wasm_out}}
    @echo "wasm: $(stat -c%s {{wasm_out}}) bytes raw, $(gzip -c {{wasm_out}} | wc -c) bytes gzipped"

build-web: wasm
    cd web && bun install --frozen-lockfile && bun run build

# Dev server. Rebuilds the wasm first; Vite watches the TypeScript.
dev: wasm
    cd web && bun run dev

preview: build-web
    cd web && bun run preview

# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

# The check that justifies the whole architecture: the browser replays the
# recorded session headlessly and its hash sequence must match the native one
# exactly (HANDOFF §6.3).
verify-cross: wasm
    cd web && node tools/verify-cross.mjs

# Replay the committed fixture natively and compare against its hashes.
verify:
    cargo run --release -p diomano-cli -- replay fixtures/session.log --verify

# Re-record the fixture. Deliberately not part of any other recipe: regenerating
# it is always a decision about changed behaviour, never a fix for a red test.
record ticks="2400" seed="0x5EED":
    cargo run --release -p diomano-cli -- record --ticks {{ticks}} --seed {{seed}}
    @echo "fixtures regenerated — if a determinism test was failing, say why in the commit"

# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------

# Per-pass ms breakdown against the 12 ms simulation budget of §4.1.
#
# NOTE: §7.6 — the reference floor is an office machine with integrated
# graphics, not a workstation. A number from here is an upper bound.
perf ticks="600":
    cargo run --release -p diomano-cli -- perf --ticks {{ticks}}

# Per-tick state hashes, for diffing two runs by hand.
hash ticks="1000" seed="0x5EED":
    cargo run --release -p diomano-cli -- hash --ticks {{ticks}} --seed {{seed}}

clean:
    cargo clean
    rm -rf web/dist web/public/diomano.wasm
