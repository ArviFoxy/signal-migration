// Encodes RGBA frames as an animated PNG that loops forever (upng-js writes a play count of 0), and reads an animated
// PNG to compare its frames with others, off the page's main thread. `colours` is the palette size; upng-js quantizes
// the frames to it.

import UPNG from 'upng-js';
import { errorMessage } from '../../core/errors';
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

const MAX_PNG_SIZE = 512;
const MAX_PNG_FRAMES = 300;
const MAX_DECODED_RGBA_BYTES = 160 * 1024 * 1024;

const opened = new Map<number, { frames: ArrayBuffer[]; width: number; height: number }>();

self.onmessage = (event: MessageEvent<EncodeRequest | OpenRequest | CompareRequest>) => {
  const request = event.data;
  const reply = (message: object, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id: request.id, ...message }, transfer);
  try {
    if ('open' in request) {
      let image: ReturnType<typeof UPNG.decode>;
      let frames: ArrayBuffer[];
      try {
        image = UPNG.decode(request.open);
        const frameCount = Math.max(1, image.frames.length);
        if (
          image.width < 1 ||
          image.height < 1 ||
          image.width > MAX_PNG_SIZE ||
          image.height > MAX_PNG_SIZE ||
          frameCount > MAX_PNG_FRAMES ||
          image.width * image.height * 4 * frameCount > MAX_DECODED_RGBA_BYTES
        ) {
          return reply({ result: null });
        }
        frames = UPNG.toRGBA8(image);
      } catch {
        // An untrusted PNG from the index that fails to decode is simply rejected as not a faithful copy.
        return reply({ result: null });
      }
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
    reply({ error: errorMessage(error) });
  }
};
