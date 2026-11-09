// A TLS connection to a Signal host, carried through a WebSocket to our relay.
//
// The TLS session runs in this page (rustls in WebAssembly) and trusts only Signal's root certificates, so the
// relay forwards ciphertext it cannot read or alter.

import { TlsSession } from '../wasm/signal_migration_wasm';
import { loadSignalWasm } from './wasm';

/** A bidirectional byte stream. */
export interface ByteStream {
  write(bytes: Uint8Array): void;
  close(): void;
  onData: (bytes: Uint8Array) => void;
  onClose: (reason: string) => void;
}

/** The relay endpoint on this page's own origin. */
export function relayUrl(host: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/tunnel/${host}`;
}

export class TlsTunnel implements ByteStream {
  onData: (bytes: Uint8Array) => void = () => undefined;
  onClose: (reason: string) => void = () => undefined;
  #socket: WebSocket;
  #session: TlsSession;
  #closed = false;

  private constructor(socket: WebSocket, session: TlsSession) {
    this.#socket = socket;
    this.#session = session;
  }

  /** Connects through the relay and completes the TLS handshake with `host`. */
  static async open(host: string): Promise<TlsTunnel> {
    await loadSignalWasm();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(relayUrl(host));
      socket.binaryType = 'arraybuffer';
      const tunnel = new TlsTunnel(socket, new TlsSession(host));
      let ready = false;
      socket.onopen = () => tunnel.#flush();
      socket.onmessage = (event) => {
        try {
          tunnel.#session.receiveEncrypted(new Uint8Array(event.data as ArrayBuffer));
          tunnel.#flush();
          if (!ready && !tunnel.#session.isHandshaking) {
            ready = true;
            resolve(tunnel);
          }
          const plaintext = tunnel.#session.takePlaintext();
          if (plaintext.length > 0) tunnel.onData(plaintext);
        } catch (error) {
          const reason = `TLS to ${host} failed: ${error instanceof Error ? error.message : String(error)}`;
          tunnel.#shutdown(reason);
          if (!ready) reject(new Error(reason));
        }
      };
      socket.onclose = () => {
        const reason = `tunnel to ${host} closed`;
        tunnel.#shutdown(reason);
        if (!ready) reject(new Error(reason));
      };
    });
  }

  write(bytes: Uint8Array): void {
    if (this.#closed) throw new Error('tunnel is closed');
    this.#session.sendPlaintext(bytes);
    this.#flush();
  }

  close(): void {
    this.#shutdown('closed by this page');
  }

  #flush(): void {
    const encrypted = this.#session.takeEncrypted();
    if (encrypted.length > 0 && this.#socket.readyState === WebSocket.OPEN) this.#socket.send(encrypted);
  }

  #shutdown(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.onclose = null;
    this.#socket.close();
    this.#session.free();
    this.onClose(reason);
  }
}
