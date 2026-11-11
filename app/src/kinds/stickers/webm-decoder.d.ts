// The WebM decoder module (webm-decoder.c), as scripts/build-webm-decoder.sh builds it with Emscripten.

declare module 'webm-decoder' {
  export type WebmDecoderModule = {
    _malloc(size: number): number;
    _free(pointer: number): void;
    /** Reads width, height, duration and frame rate into 4 doubles at `info`; the frame count, or an error < 0. */
    _webm_probe(data: number, size: number, info: number): number;
    /** Writes `count` square RGBA frames into `out`; the frames written, or an error < 0. */
    _webm_render(data: number, size: number, square: number, frameRate: number, count: number, out: number): number;
    /** Why the last call failed, as a C string. */
    _webm_error(): number;
    HEAPU8: Uint8Array;
    HEAPF64: Float64Array;
    UTF8ToString(pointer: number): string;
  };
  export default function createWebmDecoder(options?: {
    locateFile?: (path: string, prefix: string) => string;
  }): Promise<WebmDecoderModule>;
}
