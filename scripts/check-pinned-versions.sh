#!/usr/bin/env bash
# Compares the versions pinned in scripts/build-webm-decoder.sh (FFmpeg, libvpx, Emscripten) and in
# scripts/build-boringssl-wasm.sh (wasi-sdk) with the newest release tags of their repositories. Prints one line for
# each that is behind, as "name: pinned X, newest Y", and nothing when all are current. Exits 0 either way, and 1
# only when a version cannot be read.
set -euo pipefail

scripts=$(dirname "$0")
pinned() { sed -n "s/^$1=//p" "$scripts/build-tdweb.sh" "$scripts/build-webm-decoder.sh" "$scripts/build-boringssl-wasm.sh"; }

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

check OpenSSL "$(pinned OPENSSL_TAG)" "$(newest https://github.com/openssl/openssl '^openssl-3\.5\.[0-9]+$')"
check FFmpeg "$(pinned FFMPEG_TAG)" "$(newest https://github.com/FFmpeg/FFmpeg '^n[0-9]+\.[0-9]+(\.[0-9]+)?$')"
check libvpx "$(pinned LIBVPX_TAG)" "$(newest https://chromium.googlesource.com/webm/libvpx '^v[0-9]+\.[0-9]+\.[0-9]+$')"
check Emscripten "$(pinned EMSCRIPTEN_VERSION)" "$(newest https://github.com/emscripten-core/emsdk '^[0-9]+\.[0-9]+\.[0-9]+$')"
check wasi-sdk "$(pinned WASI_SDK_RELEASE)" "$(newest https://github.com/WebAssembly/wasi-sdk '^wasi-sdk-[0-9]+$')"

repo=$(cd "$scripts/.." && pwd)
pinned_root=$(jq -S -c . "$repo/app/src/attestation/trusted-root.json" | sha256sum | cut -c1-12)
tuf_base=https://tuf-repo-cdn.sigstore.dev
fetch() { curl -fsSL --connect-timeout 10 --max-time 30 "$1"; }
snap_ver=$(fetch "$tuf_base/timestamp.json" | jq -r '.signed.meta["snapshot.json"].version')
tgt_ver=$(fetch "$tuf_base/${snap_ver}.snapshot.json" | jq -r '.signed.meta["targets.json"].version')
root_hash=$(fetch "$tuf_base/${tgt_ver}.targets.json" | jq -r '.signed.targets["trusted_root.json"].hashes.sha256')
newest_root=$(fetch "$tuf_base/targets/${root_hash}.trusted_root.json" | jq -S -c . | sha256sum | cut -c1-12)
check sigstore-trusted-root "$pinned_root" "$newest_root"
