// Type declaration for upng-js, which ships none: the encoder as documented in its README.

declare module 'upng-js' {
  const UPNG: {
    /** `colours` 0 means lossless; otherwise the frames are quantized to that many colours. `delays` are in ms. */
    encode(frames: ArrayBuffer[], width: number, height: number, colours: number, delays?: number[]): ArrayBuffer;
  };
  export default UPNG;
}
