#!/usr/bin/env bash
# Runs the tests of crates/attestation-wasm. They are compiled to WebAssembly like the module itself and run in
# Node.js, so they need build/boringssl-wasm, which scripts/build-boringssl-wasm.sh makes.
set -euo pipefail

source "$(dirname "$0")/attestation-wasm-env.sh"

cd "$repo/crates/attestation-wasm"
cargo test --locked
