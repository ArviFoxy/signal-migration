#!/usr/bin/env bash
# Builds crates/attestation-wasm into app/src/wasm: the WebAssembly module with libsignal's check of an enclave's
# attestation. It needs build/boringssl-wasm, which scripts/build-boringssl-wasm.sh makes.
#
# The settings below point the `boring` crate at the BoringSSL built there, so that it does not try to build its own,
# and let its bindings generator read the headers. The generator is told that the target is wasm32-wasip1, the target
# the C library was built for: the C types have the same sizes on both, and the C library's headers refuse any other.
# `-fvisibility=default` is needed because clang hides every function by default on WebAssembly, and the generator
# skips hidden ones.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
deps=$repo/build/boringssl-wasm
[ -f "$deps/lib/libcrypto.a" ] || {
  echo "build/boringssl-wasm is missing: run scripts/build-boringssl-wasm.sh first" >&2
  exit 1
}

export BORING_BSSL_PATH=$deps
export BORING_BSSL_INCLUDE_PATH=$deps/include
export BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_unknown="--target=wasm32-wasip1 --sysroot=$deps/sysroot -fvisibility=default"

cd "$repo/crates/attestation-wasm"
cargo build --release --locked
wasm-bindgen --target web --out-dir "$repo/app/src/wasm" target/wasm32-unknown-unknown/release/attestation_wasm.wasm
wasm-opt -Oz --strip-debug --strip-producers "$repo/app/src/wasm/attestation_wasm_bg.wasm" \
  -o "$repo/app/src/wasm/attestation_wasm_bg.wasm"
ls -l "$repo/app/src/wasm/attestation_wasm_bg.wasm"
