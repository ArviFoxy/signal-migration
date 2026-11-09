// Encodes RGBA frames as an animated PNG that loops forever (upng-js writes a play count of 0), off the page's
// main thread. `colours` is the palette size; upng-js quantizes the frames to it.

import UPNG from 'upng-js';

type EncodeRequest = {
  id: number;
  frames: ArrayBuffer[];
  width: number;
  height: number;
  delays: number[];
  colours: number;
};

self.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { id, frames, width, height, delays, colours } = event.data;
  const png = UPNG.encode(frames, width, height, colours, delays);
  (self as unknown as Worker).postMessage({ id, png }, [png]);
};
