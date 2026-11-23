// HTTPS requests to a Signal host: TLS (rustls) and response parsing (httparse) in WebAssembly, carried through
// our relay.

import { NoAnswerError, REQUEST_TIME_LIMIT_S } from '../core/time-limit';
import { TlsHttpRequest } from '../wasm/signal_migration_wasm';
import type { HttpResponse } from './transport';
import { RelayLink } from './tunnel';
import { loadSignalWasm } from './wasm';

/**
 * Sends one request (with `Connection: close`). `headers` are "Name: value". Gives up with a NoAnswerError when the
 * response is not complete within the request time limit.
 */
export async function httpsRequest(
  host: string,
  method: string,
  path: string,
  headers: string[] = [],
  body: Uint8Array = new Uint8Array(0),
): Promise<HttpResponse> {
  await loadSignalWasm();
  const request = new TlsHttpRequest(host, method, path, headers, body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let link: RelayLink | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timer);
      // Close the relay link BEFORE freeing the WASM request so `link.close()` can flush safely without UAF.
      link?.close();
      link = null;
      request.free();
    };

    const settle = () => {
      if (settled || !request.isComplete) return false;
      settled = true;
      const headerMap = new Map<string, string>();
      for (const line of request.rawHeaders()) {
        const colon = line.indexOf(':');
        if (colon > 0) headerMap.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const response: HttpResponse = {
        status: request.status,
        header: (name) => headerMap.get(name.toLowerCase()),
        body: request.body(),
      };
      cleanup();
      resolve(response);
      return true;
    };

    try {
      link = new RelayLink(
        host,
        request,
        () => {
          settle();
        },
        (reason) => {
          if (settled) return;
          try {
            request.streamEnded();
          } catch {
            // The stream ended mid-response; reported below.
          }
          if (!settle()) {
            settled = true;
            cleanup();
            reject(new Error(`no complete response from ${host}: ${reason}`));
          }
        },
      );
    } catch (error) {
      settled = true;
      request.free();
      reject(error);
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new NoAnswerError('Signal', REQUEST_TIME_LIMIT_S));
    }, REQUEST_TIME_LIMIT_S * 1000);
  });
}
