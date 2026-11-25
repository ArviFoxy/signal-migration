// Decodes video stickers (WebM) off the page's main thread, with the WebM decoder (webm-decoder.c, webm-decoding.ts).

import createWebmDecoder, { type WebmDecoderModule } from 'webm-decoder';
import { assetFile, assetUrl } from '../../core/assets';
import { errorMessage } from '../../core/errors';
import { probeWebm, renderWebm, WebmDecodeError } from './webm-decoding';

/** What the page asks the worker. */
export type WebmCall =
  | { kind: 'init'; wasmUrl: string }
  | { kind: 'probe'; file: Uint8Array }
  | { kind: 'render'; file: Uint8Array; size: number; frameRate: number; count: number };

type WebmRequest = WebmCall & { id: number };

let decoder: Promise<WebmDecoderModule> | null = null;
let configuredWasmUrl: string | null = null;

/**
 * Validates that a configured WASM URL is a same-origin `blob:` or `http(s):` URL. Does not pass `self.location.href`
 * as a base because `new URL(rel, 'blob:...')` throws when the worker itself runs from a `blob:` URL.
 */
function validateWasmUrl(raw: string): string {
  const parsed = new URL(raw);
  const allowedProtocol = parsed.protocol === 'blob:' || parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (!allowedProtocol || parsed.origin !== self.location.origin) {
    throw new Error(`refusing to load WebM decoder from untrusted URL: ${parsed.origin}`);
  }
  return parsed.href;
}

function loadDecoder(): Promise<WebmDecoderModule> {
  if (!decoder) {
    const wasmUrl = configuredWasmUrl ?? assetUrl(assetFile('webmDecoderWasm'), import.meta.url);
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
    if (request.kind === 'init') {
      configuredWasmUrl = validateWasmUrl(request.wasmUrl);
      reply({ result: null });
      return;
    }
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
