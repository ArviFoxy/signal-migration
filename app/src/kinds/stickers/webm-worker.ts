// Decodes video stickers (WebM) off the page's main thread, with the WebM decoder (webm-decoder.c, webm-decoding.ts).

import createWebmDecoder, { type WebmDecoderModule } from 'webm-decoder';
import { assetFile, assetUrl } from '../../core/assets';
import { errorMessage } from '../../core/errors';
import { probeWebm, renderWebm, WebmDecodeError } from './webm-decoding';

/** What the page asks the worker. */
export type WebmCall =
  | { kind: 'probe'; file: Uint8Array }
  | { kind: 'render'; file: Uint8Array; size: number; frameRate: number; count: number };

type WebmRequest = WebmCall & { id: number };

let decoder: Promise<WebmDecoderModule> | null = null;

function loadDecoder(): Promise<WebmDecoderModule> {
  if (!decoder) {
    const wasmUrl = assetUrl(assetFile('webmDecoderWasm'), import.meta.url);
    const pending = createWebmDecoder({ locateFile: () => wasmUrl });
    decoder = pending.catch((error) => {
      if (decoder === pending) decoder = null;
      throw error;
    });
  }
  return decoder;
}

self.onmessage = async (event: MessageEvent<WebmRequest>) => {
  const request = event.data;
  const reply = (message: object, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ id: request.id, ...message }, transfer);
  let loaded: Promise<WebmDecoderModule> | null = null;
  try {
    loaded = loadDecoder();
    const module = await loaded;
    if (request.kind === 'probe') {
      reply({ result: probeWebm(module, request.file) });
    } else {
      const frames = renderWebm(module, request.file, request.size, request.frameRate, request.count);
      reply({ result: frames }, frames);
    }
  } catch (error) {
    // A WebAssembly trap or abort leaves the instance poisoned; reload a fresh one for the next call.
    if (!(error instanceof WebmDecodeError) && loaded !== null && decoder === loaded) decoder = null;
    reply({ error: errorMessage(error) });
  }
};
