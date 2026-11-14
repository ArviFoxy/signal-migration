# Settings for building crates/attestation-wasm; sourced by the scripts that build and test it.
#
# They point the `boring` crate at the BoringSSL that scripts/build-boringssl-wasm.sh built, so that it does not try
# to build its own, and let its bindings generator read the headers. The generator is told that the target is
# wasm32-wasip1, the target the C library was built for: the C types have the same sizes on both, and the C library's
# headers refuse any other. `-fvisibility=default` is needed because clang hides every function by default on
# WebAssembly, and the generator skips hidden ones.

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deps=$repo/build/boringssl-wasm
[ -f "$deps/lib/libcrypto.a" ] || {
  echo "build/boringssl-wasm is missing: run scripts/build-boringssl-wasm.sh first" >&2
  exit 1
}

export BORING_BSSL_PATH=$deps
export BORING_BSSL_INCLUDE_PATH=$deps/include
export BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_unknown="--target=wasm32-wasip1 --sysroot=$deps/sysroot -fvisibility=default"
