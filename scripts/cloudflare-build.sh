#!/usr/bin/env bash
#
# Build the web client inside Cloudflare's Workers Builds container.
#
# Set this as the **build command** in the Workers Builds settings:
#
#     bash ./scripts/cloudflare-build.sh
#
# and leave the deploy command at its default (`npx wrangler deploy`), which picks
# up `wrangler.jsonc` and uploads `web/dist`.
#
# # Why this script has to exist
#
# `web/public/diomano.wasm` is gitignored and compiled from `crates/diomano-wasm`,
# so producing `web/dist` needs cargo and the `wasm32-unknown-unknown` target. The
# Workers Builds image ships Node and Bun but **not** Rust, so the toolchain has to
# be installed here, per build, with no cargo cache. That cost is the deliberate
# price of not handing GitHub Actions a Cloudflare API token: the existing git
# integration authenticates Cloudflare→GitHub, and deploying from Actions would
# need credentials in the opposite direction.
#
# # Honest limitation
#
# The rustup-install path below cannot be exercised anywhere Rust is already
# present, which includes every machine this project is otherwise built on. If
# Cloudflare's image blocks the rustup download or ships an incompatible glibc,
# this fails here and the answer is to move the deploy back to CI with a token.

set -euo pipefail

# `wasm-opt` needs every feature rustc emits for wasm32, not just bulk-memory:
# without `nontrapping-float-to-int` it rejects the mesher's float-to-int casts.
# Kept identical to the `justfile`; if one changes, change both.
WASM_FEATURES=(
  --enable-bulk-memory
  --enable-nontrapping-float-to-int
  --enable-sign-ext
  --enable-mutable-globals
  --enable-multivalue
  --enable-reference-types
  --enable-extended-const
)

WASM_RAW="target/wasm32-unknown-unknown/release/diomano_wasm.wasm"
WASM_OUT="web/public/diomano.wasm"

# Run from the repository root regardless of where the build command is invoked,
# so a changed "root directory" setting cannot silently build the wrong tree.
cd "$(dirname "$0")/.."

echo "==> toolchain"
if command -v cargo >/dev/null 2>&1; then
  echo "cargo already present: $(cargo --version)"
else
  echo "installing rust (no cargo in this image)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown

# Web dependencies first: `wasm-opt` comes from the `binaryen` devDependency, so
# it does not exist until this has run.
echo "==> web dependencies"
cd web
bun install --frozen-lockfile
cd ..

echo "==> wasm"
cargo build --release --target wasm32-unknown-unknown -p diomano-wasm
mkdir -p web/public
./web/node_modules/.bin/wasm-opt -Oz "${WASM_FEATURES[@]}" "$WASM_RAW" -o "$WASM_OUT"
echo "wasm: $(stat -c%s "$WASM_OUT") bytes raw, $(gzip -c "$WASM_OUT" | wc -c) bytes gzipped"

echo "==> client"
cd web
bun run build
cd ..

# Fail loudly rather than letting wrangler deploy an empty directory: an
# assets-only Worker with no assets is a successful deploy of a blank site, which
# is worse than a failed build.
for required in web/dist/index.html web/dist/diomano.wasm; do
  if [[ ! -f "$required" ]]; then
    echo "build produced no $required" >&2
    exit 1
  fi
done

echo "==> done"
find web/dist -type f -printf '%-40p %10s bytes\n' | sort
