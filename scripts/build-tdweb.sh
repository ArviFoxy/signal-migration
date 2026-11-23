#!/usr/bin/env bash
# Builds TDLib's web client (tdweb) from the third_party/td submodule: OpenSSL 3.5 LTS for WebAssembly, the TDLib
# WebAssembly module into the submodule's example/web/tdweb/src/prebuilt, then the JavaScript, patched, into
# build/tdweb/dist (scripts/build-tdweb-js.sh).
#
# OpenSSL is built here directly from a pinned OpenSSL 3.5 LTS release instead of TDLib's example/web/build-openssl.sh
# (which hardcodes EOL OpenSSL 1.1.0l). TDLib is built at -Os, at which Emscripten also minifies the JavaScript it
# generates, with precompiled headers and link-time optimization enabled. Function names in the WebAssembly module are
# left out, as in TDLib's own build.
#
# Needs emsdk with Emscripten 3.1.1, the version TDLib's scripts check for. Set EMSDK to an emsdk directory;
# without it, emsdk is cloned into build/emsdk and 3.1.1 is installed there.
set -euo pipefail

EMSDK_VERSION=7.0.0
EMSDK_COMMIT=1693ce7359fc9694f198694f902a2cc061239b86
OPENSSL_TAG=openssl-3.5.9
OPENSSL_VERSION=3.5.9
OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

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

openssl_work=$repo/build/tdweb-openssl/$OPENSSL_TAG
crypto=$openssl_work/install
if [ ! -f "$crypto/.complete" ]; then
  mkdir -p "$openssl_work"
  archive=$openssl_work/$OPENSSL_TAG.tar.gz
  if [ ! -f "$archive" ]; then
    tmp="$archive.tmp"
    rm -f "$tmp"
    curl -fsSLo "$tmp" "https://github.com/openssl/openssl/releases/download/$OPENSSL_TAG/$OPENSSL_TAG.tar.gz"
    echo "$OPENSSL_SHA256  $tmp" | sha256sum -c -
    mv "$tmp" "$archive"
  else
    echo "$OPENSSL_SHA256  $archive" | sha256sum -c -
  fi
  rm -rf "$openssl_work/src" "$crypto"
  mkdir -p "$openssl_work/src"
  tar -xzf "$archive" -C "$openssl_work/src" --strip-components=1
  (
    cd "$openssl_work/src"
    CC=emcc CXX=em++ AR=emar RANLIB=emranlib CROSS_COMPILE="" ./Configure linux-generic32 \
      no-shared no-threads no-dso no-engine no-asm no-apps no-docs no-tests \
      no-module no-quic no-afalgeng no-ui-console no-ssl3 no-dtls \
      --prefix="$crypto" --openssldir="$crypto/ssl" -Os
    make -j"$(nproc)" build_libs
    make install_dev
  )
  touch "$crypto/.complete"
fi

td=$repo/third_party/td
web=$td/example/web
cd "$web"

openssl_options=(
  -DOPENSSL_FOUND=1
  "-DOPENSSL_ROOT_DIR=$crypto"
  "-DOPENSSL_INCLUDE_DIR=$crypto/include"
  "-DOPENSSL_CRYPTO_LIBRARY=$crypto/lib/libcrypto.a"
  "-DOPENSSL_SSL_LIBRARY=$crypto/lib/libssl.a"
  "-DOPENSSL_LIBRARIES=$crypto/lib/libssl.a;$crypto/lib/libcrypto.a"
  "-DOPENSSL_VERSION=$OPENSSL_VERSION"
)

if [ -f build/wasm/CMakeCache.txt ] && ! grep -qF "OPENSSL_ROOT_DIR:UNINITIALIZED=$crypto" build/wasm/CMakeCache.txt \
   && ! grep -qF "OPENSSL_ROOT_DIR:PATH=$crypto" build/wasm/CMakeCache.txt; then
  rm -rf build/wasm
fi

mkdir -p build/generate build/wasm
(cd build/generate && cmake -DTD_GENERATE_SOURCE_FILES=ON "$td")
cmake --build build/generate --parallel "$(nproc)"
(cd build/wasm && emcmake cmake -DCMAKE_BUILD_TYPE=MinSizeRel -DTD_ENABLE_PCH=ON -DTD_ENABLE_LTO=ON \
  "${openssl_options[@]}" "$td")
cmake --build build/wasm --target td_wasm --parallel "$(nproc)"
./copy-tdlib.sh

"$repo/scripts/build-tdweb-js.sh"
