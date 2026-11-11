#!/usr/bin/env bash
# Builds the decoder for Telegram's video stickers: WebM files with VP9 video and a transparency channel, which WebM
# keeps as a second VP9 stream beside the video. Only these parts of FFmpeg are built: the Matroska (WebM) reader,
# the VP9 decoder of libvpx (FFmpeg's own VP9 decoder ignores the transparency channel), and swscale for colour
# conversion. With app/src/kinds/stickers/webm-decoder.c they are compiled to WebAssembly, without threads, assembly
# or a file system. Output: build/webm-decoder/webm-decoder.js and webm-decoder.wasm, which app/build.mjs bundles
# into the app as the module "webm-decoder" (declared in app/src/kinds/stickers/webm-decoder.d.ts).
#
# FFmpeg and libvpx are fetched at the versions pinned below and built into a folder under build/webm-decoder named
# after the three versions, so that changing one builds everything again; a library already built there is not
# built again. Emscripten is installed at its pinned version into build/emsdk-webm, unless EMSDK is set.
set -euo pipefail

FFMPEG_TAG=n9.0.2
LIBVPX_TAG=v1.17.0
EMSCRIPTEN_VERSION=7.0.0

repo=$(cd "$(dirname "$0")/.." && pwd)
out=$repo/build/webm-decoder
work=$out/ffmpeg-$FFMPEG_TAG-libvpx-$LIBVPX_TAG-emscripten-$EMSCRIPTEN_VERSION
src=$work/src
prefix=$work/prefix
mkdir -p "$src" "$prefix"

if [ -z "${EMSDK:-}" ]; then
  EMSDK=$repo/build/emsdk-webm
  [ -d "$EMSDK" ] || git clone https://github.com/emscripten-core/emsdk.git "$EMSDK"
  "$EMSDK/emsdk" install "$EMSCRIPTEN_VERSION"
  "$EMSDK/emsdk" activate "$EMSCRIPTEN_VERSION"
fi
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

[ -d "$src/libvpx" ] || git clone --depth 1 --branch "$LIBVPX_TAG" https://chromium.googlesource.com/webm/libvpx "$src/libvpx"
[ -d "$src/ffmpeg" ] || git clone --depth 1 --branch "$FFMPEG_TAG" https://github.com/FFmpeg/FFmpeg "$src/ffmpeg"

jobs=$(nproc)

if [ ! -f "$prefix/lib/libvpx.a" ]; then
  (
    cd "$src/libvpx"
    emconfigure ./configure \
      --prefix="$prefix" --target=generic-gnu \
      --disable-vp8 --disable-vp9-encoder --disable-multithread --disable-runtime-cpu-detect \
      --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-install-bins \
      --enable-static --disable-shared --extra-cflags=-O3
    emmake make -j"$jobs"
    emmake make install
  )
fi

if [ ! -f "$prefix/lib/libavcodec.a" ]; then
  (
    cd "$src/ffmpeg"
    PKG_CONFIG_PATH=$prefix/lib/pkgconfig emconfigure ./configure \
      --prefix="$prefix" --target-os=none --arch=x86_32 --enable-cross-compile \
      --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --ar=emar --ranlib=emranlib --nm=emnm \
      --disable-everything --disable-autodetect --disable-programs --disable-doc --disable-debug \
      --disable-asm --disable-inline-asm --disable-x86asm --disable-runtime-cpudetect \
      --disable-pthreads --disable-w32threads --disable-os2threads --disable-network \
      --disable-avdevice --disable-avfilter --disable-swresample --disable-iconv \
      --enable-libvpx --enable-demuxer=matroska --enable-decoder=libvpx_vp9 \
      --pkg-config=pkg-config --pkg-config-flags=--static \
      --extra-cflags="-I$prefix/include -O3" --extra-ldflags="-L$prefix/lib"
    emmake make -j"$jobs"
    emmake make install
  )
fi

emcc -O3 "$repo/app/src/kinds/stickers/webm-decoder.c" \
  -I"$prefix/include" \
  "$prefix/lib/libavformat.a" "$prefix/lib/libavcodec.a" "$prefix/lib/libswscale.a" "$prefix/lib/libavutil.a" \
  "$prefix/lib/libvpx.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createWebmDecoder -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_webm_probe,_webm_render,_webm_error,_webm_set_filter \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF64,UTF8ToString \
  -o "$out/webm-decoder.js"
ls -l "$out/webm-decoder.js" "$out/webm-decoder.wasm"
