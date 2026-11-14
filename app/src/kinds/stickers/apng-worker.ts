// Encodes RGBA frames as an animated PNG that loops forever (upng-js writes a play count of 0), and reads an animated
// PNG to compare its frames with others, off the page's main thread. `colours` is the palette size; upng-js quantizes
// the frames to it.

import UPNG from 'upng-js';
import { largestDifference } from './frame-difference';

type EncodeRequest = {
  id: number;
  frames: ArrayBuffer[];
  width: number;
  height: number;
  delays: number[];
  colours: number;
};
/** Reads a file and keeps its frames under `id` until they are compared or dropped. */
type OpenRequest = { id: number; open: ArrayBuffer };
/** Compares the frames kept under `key` with `frames`, or drops them when there are none to compare with. */
type CompareRequest = { id: number; compare: { key: number; frames: ArrayBuffer[] | null } };

/** What the worker answers to an open request. */
export type OpenedPng = { key: number; width: number; height: number; delays: number[]; frameCount: number };

const opened = new Map<number, { frames: ArrayBuffer[]; width: number; height: number }>();

self.onmessage = (event: MessageEvent<EncodeRequest | OpenRequest | CompareRequest>) => {
  const request = event.data;
  const reply = (message: object, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id: request.id, ...message }, transfer);
  try {
    if ('open' in request) {
      const image = UPNG.decode(request.open);
      const frames = UPNG.toRGBA8(image);
      opened.set(request.id, { frames, width: image.width, height: image.height });
      const result: OpenedPng = {
        key: request.id,
        width: image.width,
        height: image.height,
        delays: image.frames.map((frame) => frame.delay),
        frameCount: frames.length,
      };
      reply({ result });
    } else if ('compare' in request) {
      const kept = opened.get(request.compare.key);
      opened.delete(request.compare.key);
      const others = request.compare.frames;
      if (!kept || !others) return reply({ result: null });
      if (others.length !== kept.frames.length) return reply({ result: 255 });
      let largest = 0;
      for (let i = 0; i < others.length; i++) {
        const [frame, other] = [new Uint8Array(kept.frames[i]), new Uint8Array(others[i])];
        largest = largestDifference(frame, other, kept.width, kept.height, largest);
      }
      reply({ result: largest });
    } else {
      const { frames, width, height, delays, colours } = request;
      const png = UPNG.encode(frames, width, height, colours, delays);
      reply({ result: png }, [png]);
    }
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  }
};
