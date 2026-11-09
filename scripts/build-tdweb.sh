#!/usr/bin/env bash
# Builds TDLib's web client (tdweb) from the third_party/td submodule: the WebAssembly module into the submodule's
# example/web/tdweb/src/prebuilt, then the JavaScript, patched, into build/tdweb/dist (scripts/build-tdweb-js.sh).
#
# The steps are TDLib's own (example/web/build-openssl.sh, build-tdlib.sh, copy-tdlib.sh, build-tdweb.sh),
# with one change: the WebAssembly module is linked with -g1. TDLib builds with -Os, and at -Os Emscripten
# strips all whitespace from the JavaScript it generates. -g1 keeps that JavaScript formatted as written.
# Function names in the WebAssembly module are left out, as in TDLib's own build: TDLib's mangled C++ names
# take 128 MB, against 15 MB for the whole module without them.
#
# Needs emsdk with Emscripten 3.1.1, the version TDLib's scripts check for. Set EMSDK to an emsdk directory;
# without it, emsdk is cloned into build/emsdk and 3.1.1 is installed there.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${EMSDK:-}" ]; then
  EMSDK=$repo/build/emsdk
  [ -d "$EMSDK" ] || git clone https://github.com/emscripten-core/emsdk.git "$EMSDK"
  "$EMSDK/emsdk" install 3.1.1
  "$EMSDK/emsdk" activate 3.1.1
fi
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

td=$repo/third_party/td
web=$td/example/web
cd "$web"
[ -f build/crypto/lib/libcrypto.a ] || ./build-openssl.sh

crypto=$web/build/crypto
openssl_options=(
  -DOPENSSL_FOUND=1
  "-DOPENSSL_ROOT_DIR=$crypto"
  "-DOPENSSL_INCLUDE_DIR=$crypto/include"
  "-DOPENSSL_CRYPTO_LIBRARY=$crypto/lib/libcrypto.a"
  "-DOPENSSL_SSL_LIBRARY=$crypto/lib/libssl.a"
  "-DOPENSSL_LIBRARIES=$crypto/lib/libssl.a;$crypto/lib/libcrypto.a"
  -DOPENSSL_VERSION=1.1.0l
)

mkdir -p build/generate build/wasm
(cd build/generate && cmake -DTD_GENERATE_SOURCE_FILES=ON "$td")
cmake --build build/generate
(cd build/wasm && emcmake cmake -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_EXE_LINKER_FLAGS=-g1 "${openssl_options[@]}" "$td")
cmake --build build/wasm --target td_wasm
./copy-tdlib.sh

"$repo/scripts/build-tdweb-js.sh"
