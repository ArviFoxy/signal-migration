#!/usr/bin/env bash
# Builds crates/attestation-wasm into app/src/wasm: the WebAssembly module with libsignal's check of an enclave's
# attestation. It needs build/boringssl-wasm, which scripts/build-boringssl-wasm.sh makes.
set -euo pipefail

source "$(dirname "$0")/attestation-wasm-env.sh"

cd "$repo/crates/attestation-wasm"
cargo build --release --locked
wasm-bindgen --target web --out-dir "$repo/app/src/wasm" target/wasm32-unknown-unknown/release/attestation_wasm.wasm
wasm-opt -Oz --strip-debug --strip-producers "$repo/app/src/wasm/attestation_wasm_bg.wasm" \
  -o "$repo/app/src/wasm/attestation_wasm_bg.wasm"
ls -l "$repo/app/src/wasm/attestation_wasm_bg.wasm"
