#!/usr/bin/env bash
# Builds TDLib's web client (tdweb) from the third_party/td submodule: the WebAssembly module into the submodule's
# example/web/tdweb/src/prebuilt, then the JavaScript, patched, into build/tdweb/dist (scripts/build-tdweb-js.sh).
#
# The steps are TDLib's own (example/web/build-openssl.sh, build-tdlib.sh, copy-tdlib.sh, build-tdweb.sh), built at
# TDLib's -Os, at which Emscripten also minifies the JavaScript it generates, and with two of TDLib's own build
# options: precompiled headers, which shorten the compilation, and link-time optimization, which lets the linker
# drop code nothing reaches.
# Function names in the WebAssembly module are left out, as in TDLib's own build: TDLib's mangled C++ names
# take 128 MB, against 15 MB for the whole module without them.
#
# Needs emsdk with Emscripten 3.1.1, the version TDLib's scripts check for. Set EMSDK to an emsdk directory;
# without it, emsdk is cloned into build/emsdk and 3.1.1 is installed there.
set -euo pipefail

EMSDK_VERSION=7.0.0
EMSDK_COMMIT=1693ce7359fc9694f198694f902a2cc061239b86
OPENSSL_ARCHIVE=OpenSSL_1_1_0l.tar.gz
OPENSSL_SHA256=e2acf0cf58d9bff2b42f2dc0aee79340c8ffe2c5e45d3ca4533dd5d4f5775b1d

repo=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${EMSDK:-}" ]; then
  EMSDK=$repo/build/emsdk
  if [ ! -d "$EMSDK" ]; then
    tmp="$EMSDK.tmp"
    rm -rf "$tmp"
    git clone --depth 1 --branch "$EMSDK_VERSION" https://github.com/emscripten-core/emsdk.git "$tmp"
    actual=$(git -C "$tmp" rev-parse HEAD)
    [ "$actual" = "$EMSDK_COMMIT" ] || { echo "emsdk commit mismatch: expected $EMSDK_COMMIT, got $actual" >&2; exit 1; }
    mv "$tmp" "$EMSDK"
  fi
  "$EMSDK/emsdk" install 3.1.1
  "$EMSDK/emsdk" activate 3.1.1
fi
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

td=$repo/third_party/td
web=$td/example/web
cd "$web"
# Pre-fetch and SHA-256-verify OpenSSL before TDLib's build-openssl.sh runs so it never curls an unverified tarball.
if [ ! -f "$OPENSSL_ARCHIVE" ]; then
  tmp="$OPENSSL_ARCHIVE.tmp"
  rm -f "$tmp"
  curl -fsSLo "$tmp" "https://github.com/openssl/openssl/archive/$OPENSSL_ARCHIVE"
  echo "$OPENSSL_SHA256  $tmp" | sha256sum -c -
  mv "$tmp" "$OPENSSL_ARCHIVE"
else
  echo "$OPENSSL_SHA256  $OPENSSL_ARCHIVE" | sha256sum -c -
fi
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
cmake --build build/generate --parallel "$(nproc)"
(cd build/wasm && emcmake cmake -DCMAKE_BUILD_TYPE=MinSizeRel -DTD_ENABLE_PCH=ON -DTD_ENABLE_LTO=ON \
  "${openssl_options[@]}" "$td")
cmake --build build/wasm --target td_wasm --parallel "$(nproc)"
./copy-tdlib.sh

"$repo/scripts/build-tdweb-js.sh"
