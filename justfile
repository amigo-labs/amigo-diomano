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
# Deploy
# ---------------------------------------------------------------------------

# Validate `wrangler.jsonc` without uploading anything.
#
# Needs no credentials, which is the point: it runs inside `just check`, so a
# malformed deploy config fails on the pull request rather than on main, where the
# only way to find out is a failed deploy.
#
# Depends on `build-web` because it has to: wrangler resolves `assets.directory`
# eagerly and exits 1 if `web/dist` is absent, so a dry run against an unbuilt tree
# tests nothing and fails for the wrong reason. The useful side effect is that the
# production build — `tsc --noEmit && vite build` — now runs on every pull request
# instead of only at deploy time.
deploy-check: build-web
    WRANGLER_SEND_METRICS=false ./web/node_modules/.bin/wrangler deploy --dry-run

# Exactly what Cloudflare's Workers Builds container runs, runnable here.
#
# The point of having this as a recipe is that the deploy build is testable without
# waiting for a deploy: it installs the Rust toolchain only when cargo is missing,
# so locally it skips straight to building. The rustup path itself can therefore
# only be exercised on Cloudflare — which is the one honest gap in this setup.
cf-build:
    bash ./scripts/cloudflare-build.sh

# Publish by hand, from a machine that already has the toolchain.
#
# **Not the normal path.** Cloudflare's git integration builds and deploys on every
# push to the connected branch; this exists for the case where you need to push a
# build out without going through git. Requires CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID, which CI deliberately does not have — see `wrangler.jsonc`
# for why there is only ever one automated publisher.
deploy: build-web
    WRANGLER_SEND_METRICS=false ./web/node_modules/.bin/wrangler deploy

# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

# The check that justifies the whole architecture: the browser replays the
# recorded session headlessly and its hash sequence must match the native one
# exactly (HANDOFF §6.3).
verify-cross: wasm
    cd web && node tools/verify-cross.mjs

# Two simulations through the lockstep layer over a lossy, latent link.
#
# The Phase 7 DoD's network conditions — 120 ms RTT, 2% loss — without a network.
# Also checks that the desync detector *fires* when fed a divergence, because a
# check that has never been seen to trip is a comment.
verify-lockstep: wasm
    cd web && bun tools/verify-lockstep.ts

# Replay the committed fixture natively and compare against its hashes.
verify:
    cargo run --release -p diomano-cli -- replay fixtures/session.log --verify

# Replay one corpus match, natively and then in headless Chromium.
#
# Used by the CI matrix, which runs the ten in parallel so the wall clock is one
# match rather than the sum. Both halves matter: §6.3 asks for the corpus to
# replay *bit-identically native vs. headless browser*, so a native-only check
# would be verifying the easy half of the criterion.
verify-match n: wasm
    cargo run --release -p diomano-cli -- replay fixtures/match-{{n}}.log --verify
    cd web && node tools/verify-cross.mjs ../fixtures/match-{{n}}.log

# Replay the whole §6.3 corpus and check its coverage: ten matches of 20,000
# ticks, every verb 20+ times, 200+ combat resolutions.
#
# The combat criterion is reported as a KNOWN GAP rather than enforced — see the
# note the command prints, and `CATACLYSM_FROM` in the CLI. `--strict` enforces it.
verify-corpus:
    cargo run --release -p diomano-cli -- corpus --check-only

# What did a log actually exercise?
census file:
    cargo run --release -p diomano-cli -- census {{file}}

# Walk a scripted match and print the economy, for working out *why* a corpus
# match covered less than it should have.
trace ticks="4000" every="400" seed="0x5EED0000":
    cargo run --release -p diomano-cli -- trace --ticks {{ticks}} --every {{every}} --seed {{seed}}

# Re-record the whole §6.3 corpus. Same warning as `record`, ten times over.
record-corpus:
    cargo run --release -p diomano-cli -- corpus
    @echo "corpus regenerated — say in the commit why the hashes moved"

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
