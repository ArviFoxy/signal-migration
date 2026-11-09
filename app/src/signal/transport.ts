// The two ways the page talks to Signal, as interfaces: requests over the logged-in chat connection, and HTTPS
// requests to a Signal host. In the app both go through our relay (socket.ts, http-client.ts); tests supply
// simulated ones.

import type { StorageClient } from './storage';

/** A response on the chat connection, as in Signal's WebSocketResponseMessage. Headers are "name:value". */
export type ChatResponse = { status: number; message: string; headers: string[]; body: Uint8Array };

/** A logged-in chat connection. */
export interface ChatChannel {
  request(verb: string, path: string, options?: { body?: Uint8Array; headers?: string[] }): Promise<ChatResponse>;
}

export type HttpResponse = { status: number; header: (name: string) => string | undefined; body: Uint8Array };

/** One HTTPS request to a Signal host; `headers` are "Name: value". */
export type HttpsRequest = (
  host: string,
  method: string,
  path: string,
  headers?: string[],
  body?: Uint8Array,
) => Promise<HttpResponse>;

/**
 * A linked Signal account as the migration kinds use it. In the app it is the temporary linked device
 * (connection.ts); tests supply one over a simulated Signal service.
 */
export interface SignalAccount {
  /** False once the device was unlinked, here or from the phone. */
  readonly isLinked: boolean;
  /** Runs `action` over the logged-in chat connection, opening the connection again once if it dropped. */
  withChat<T>(action: (chat: ChatChannel) => Promise<T>): Promise<T>;
  /** HTTPS to Signal's hosts. */
  readonly https: HttpsRequest;
  /** The account's storage service, with fresh credentials. */
  storage(): Promise<StorageClient>;
}

/** Reads a header from chat response headers. */
export function chatHeader(headers: string[], name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`;
  return headers
    .find((line) => line.toLowerCase().startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}
