// Type declaration for upng-js, which ships none: the encoder and decoder as documented in its README.

declare module 'upng-js' {
  /** A decoded PNG file. `frames` is empty for a file that is not animated. */
  type Image = { width: number; height: number; frames: { delay: number }[] };
  const UPNG: {
    /** `colours` 0 means lossless; otherwise the frames are quantized to that many colours. `delays` are in ms. */
    encode(frames: ArrayBuffer[], width: number, height: number, colours: number, delays?: number[]): ArrayBuffer;
    decode(file: ArrayBuffer): Image;
    /** The frames of a decoded file as RGBA, each the whole picture; one frame for a file that is not animated. */
    toRGBA8(image: Image): ArrayBuffer[];
  };
  export default UPNG;
}
