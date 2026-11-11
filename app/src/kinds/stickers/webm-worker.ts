// Decodes video stickers (WebM) off the page's main thread, with the WebM decoder (webm-decoder.c, webm-decoding.ts).

import createWebmDecoder from 'webm-decoder';
import { probeWebm, renderWebm } from './webm-decoding';

/** What the page asks the worker. */
export type WebmCall =
  | { kind: 'probe'; file: Uint8Array }
  | { kind: 'render'; file: Uint8Array; size: number; frameRate: number; count: number }
  /** Chooses how frames are scaled down from here on (webm-decoder.c webm_set_filter). */
  | { kind: 'filter'; filter: number };

type WebmRequest = WebmCall & { id: number };

const decoder = createWebmDecoder({ locateFile: () => '/webm-decoder.wasm' });

self.onmessage = async (event: MessageEvent<WebmRequest>) => {
  const request = event.data;
  const reply = (message: object, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id: request.id, ...message }, transfer);
  try {
    const module = await decoder;
    if (request.kind === 'filter') {
      module._webm_set_filter(request.filter);
      reply({ result: null });
    } else if (request.kind === 'probe') {
      reply({ result: probeWebm(module, request.file) });
    } else {
      const frames = renderWebm(module, request.file, request.size, request.frameRate, request.count);
      reply({ result: frames }, frames);
    }
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  }
};
