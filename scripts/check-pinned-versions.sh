#!/usr/bin/env bash
# Compares the versions pinned in scripts/build-webm-decoder.sh (FFmpeg, libvpx, Emscripten) and in
# scripts/build-boringssl-wasm.sh (wasi-sdk) with the newest release tags of their repositories. Prints one line for
# each that is behind, as "name: pinned X, newest Y", and nothing when all are current. Exits 0 either way, and 1
# only when a version cannot be read.
set -euo pipefail

scripts=$(dirname "$0")
pinned() { sed -n "s/^$1=//p" "$scripts/build-webm-decoder.sh" "$scripts/build-boringssl-wasm.sh"; }

# The newest of a repository's release tags that match `pattern` (an extended regular expression).
newest() { git ls-remote --tags --refs "$1" | sed 's|.*refs/tags/||' | grep -E "$2" | sort -V | tail -1; }

check() {
  local name=$1 pinned=$2 newest=$3
  if [ -z "$pinned" ] || [ -z "$newest" ]; then
    echo "$name: cannot read the pinned version ('$pinned') or the newest one ('$newest')" >&2
    exit 1
  fi
  [ "$pinned" = "$newest" ] || echo "$name: pinned $pinned, newest $newest"
}

check FFmpeg "$(pinned FFMPEG_TAG)" "$(newest https://github.com/FFmpeg/FFmpeg '^n[0-9]+\.[0-9]+(\.[0-9]+)?$')"
check libvpx "$(pinned LIBVPX_TAG)" "$(newest https://chromium.googlesource.com/webm/libvpx '^v[0-9]+\.[0-9]+\.[0-9]+$')"
check Emscripten "$(pinned EMSCRIPTEN_VERSION)" "$(newest https://github.com/emscripten-core/emsdk '^[0-9]+\.[0-9]+\.[0-9]+$')"
check wasi-sdk "$(pinned WASI_SDK_RELEASE)" "$(newest https://github.com/WebAssembly/wasi-sdk '^wasi-sdk-[0-9]+$')"
