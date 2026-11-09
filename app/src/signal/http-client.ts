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
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      link.close();
      request.free();
      reject(new NoAnswerError('Signal', REQUEST_TIME_LIMIT_S));
    }, REQUEST_TIME_LIMIT_S * 1000);
    const settle = () => {
      if (settled || !request.isComplete) return false;
      settled = true;
      clearTimeout(timer);
      const response: HttpResponse = {
        status: request.status,
        header: (name) => request.header(name),
        body: request.body(),
      };
      request.free();
      resolve(response);
      return true;
    };
    const link = new RelayLink(
      host,
      request,
      () => {
        if (settle()) link.close();
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
          clearTimeout(timer);
          request.free();
          reject(new Error(`no complete response from ${host}: ${reason}`));
        }
      },
    );
  });
}
