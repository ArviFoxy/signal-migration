// HTTPS requests to a Signal host: TLS (rustls) and response parsing (httparse) in WebAssembly, carried through
// our relay.

import { TlsHttpRequest } from '../wasm/signal_migration_wasm';
import type { HttpResponse } from './transport';
import { RelayLink } from './tunnel';
import { loadSignalWasm } from './wasm';

/** Sends one request (with `Connection: close`). `headers` are "Name: value". */
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
    const settle = () => {
      if (settled || !request.isComplete) return false;
      settled = true;
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
          request.free();
          reject(new Error(`no complete response from ${host}: ${reason}`));
        }
      },
    );
  });
}
