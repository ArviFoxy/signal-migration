#!/usr/bin/env bash
# Builds BoringSSL for WebAssembly, for crates/attestation-wasm. That crate runs libsignal's check of an enclave's
# attestation in the browser. libsignal does the check's certificate and signature work with BoringSSL, a C library,
# and the Rust target the app is built for (wasm32-unknown-unknown) has no C library. So BoringSSL is built here with
# wasi-sdk, a C toolchain and C library for WebAssembly, and the Rust build links the result.
#
# Output, in build/boringssl-wasm:
#   lib/      libcrypto.a and libssl.a, and the compiler runtime they need
#   include/  BoringSSL's headers, from which the Rust bindings are generated
#   sysroot/  the C and C++ libraries of wasi-sdk and their headers, for the one target used
#   libc/     the Rust crate `libc` with crates/attestation-wasm/libc-wasm32-unknown.patch applied; without the
#             patch that crate defines no C types for the app's target
#
# Nothing is chosen here that libsignal already fixes: the BoringSSL source is the one the `boring` crate carries at
# the tag in third_party/libsignal/Cargo.toml, and the `libc` crate is the version in third_party/libsignal/Cargo.lock.
# BoringSSL is built without changes to its source beyond the patch that the `boring` crate itself always applies.
# The four OPENSSL_NO_ switches are BoringSSL's own, for platforms without threads, files and sockets.
#
# wasi-sdk is fetched at the version pinned below into build/boringssl-wasm/work, unless WASI_SDK names a copy.
# Everything is built into a folder under work/ named after the versions, so that changing one builds again.
set -euo pipefail

WASI_SDK_RELEASE=wasi-sdk-34
WASI_SDK_FILE=wasi-sdk-34.0-x86_64-linux
WASI_SDK_SHA256=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4
WASI_TARGET=wasm32-wasip1

repo=$(cd "$(dirname "$0")/.." && pwd)
libsignal=$repo/third_party/libsignal
out=$repo/build/boringssl-wasm

boring_tag=$(sed -n 's/^boring-signal = .*tag = "\([^"]*\)".*/\1/p' "$libsignal/Cargo.toml")
libc_version=$(sed -n '/^name = "libc"$/{n;s/^version = "\(.*\)"/\1/p}' "$libsignal/Cargo.lock")
libc_sha256=$(sed -n '/^name = "libc"$/{n;n;n;s/^checksum = "\(.*\)"/\1/p}' "$libsignal/Cargo.lock")
[ -n "$boring_tag" ] && [ -n "$libc_version" ] && [ -n "$libc_sha256" ] || {
  echo "could not read the boring tag or the libc version from $libsignal" >&2
  exit 1
}

work=$out/work/$WASI_SDK_RELEASE-boring-$boring_tag
mkdir -p "$work"

if [ -z "${WASI_SDK:-}" ]; then
  WASI_SDK=$out/work/$WASI_SDK_FILE
  if [ ! -d "$WASI_SDK" ]; then
    archive=$out/work/$WASI_SDK_FILE.tar.gz
    curl -fsSLo "$archive" "https://github.com/WebAssembly/wasi-sdk/releases/download/$WASI_SDK_RELEASE/$WASI_SDK_FILE.tar.gz"
    echo "$WASI_SDK_SHA256  $archive" | sha256sum -c -
    tar -xzf "$archive" -C "$out/work"
    rm "$archive"
  fi
fi

boring=$work/boring
if [ ! -d "$boring" ]; then
  git clone --depth 1 --branch "$boring_tag" https://github.com/signalapp/boring "$boring"
  git -C "$boring" submodule update --init --depth 1 boring-sys/deps/boringssl
  # The one patch the boring crate applies whatever its features are (boring-sys/build/main.rs).
  git -C "$boring/boring-sys/deps/boringssl" apply "$boring/boring-sys/patches/boring-pq.patch"
fi
source=$boring/boring-sys/deps/boringssl

if [ ! -f "$work/build/libcrypto.a" ] || [ ! -f "$work/build/libssl.a" ]; then
  flags="-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_FILESYSTEM -DOPENSSL_NO_POSIX_IO -DOPENSSL_NO_SOCK"
  cmake -S "$source" -B "$work/build" \
    -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" -DWASI_SDK_PREFIX="$WASI_SDK" \
    -DCMAKE_BUILD_TYPE=Release -DOPENSSL_NO_ASM=1 -DBUILD_TESTING=OFF \
    "-DCMAKE_C_FLAGS=$flags" "-DCMAKE_CXX_FLAGS=$flags"
  cmake --build "$work/build" --target crypto ssl -j"$(nproc)"
fi

rm -rf "$out/lib" "$out/include" "$out/sysroot" "$out/libc"
mkdir -p "$out/lib" "$out/sysroot/include" "$out/sysroot/lib"
cp "$work/build/libcrypto.a" "$work/build/libssl.a" "$out/lib/"
cp "$WASI_SDK"/lib/clang/*/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a "$out/lib/"
cp -r "$source/include" "$out/include"
cp -r "$WASI_SDK/share/wasi-sysroot/include/$WASI_TARGET" "$out/sysroot/include/"
cp -r "$WASI_SDK/share/wasi-sysroot/lib/$WASI_TARGET" "$out/sysroot/lib/"

crate=$work/libc-$libc_version.crate
[ -f "$crate" ] || curl -fsSLo "$crate" "https://static.crates.io/crates/libc/libc-$libc_version.crate"
echo "$libc_sha256  $crate" | sha256sum -c -
mkdir "$out/libc"
tar -xzf "$crate" -C "$out/libc" --strip-components=1
patch -d "$out/libc" -p1 < "$repo/crates/attestation-wasm/libc-wasm32-unknown.patch"

du -sh "$out/lib" "$out/include" "$out/sysroot" "$out/libc"
