// Carries a WebAssembly connection's ciphertext through a WebSocket to our relay.
//
// TLS to the Signal host runs in this page (rustls in WebAssembly) and trusts only Signal's root certificates, so
// the relay forwards ciphertext it cannot read or alter.

/** The ciphertext side of a TLS connection object from the WebAssembly module. */
export interface EncryptedEndpoint {
  receiveEncrypted(data: Uint8Array): void;
  takeEncrypted(): Uint8Array;
}

/** The relay endpoint on this page's own origin. */
export function relayUrl(host: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/tunnel/${host}`;
}

export class RelayLink {
  #socket: WebSocket;
  #endpoint: EncryptedEndpoint;
  #closed = false;

  /**
   * Opens the relay to `host` for `endpoint`. `onReceive` runs after each batch of ciphertext is fed in; it may
   * throw, which closes the link. `onClose` runs once, when the link closes for any reason.
   */
  constructor(host: string, endpoint: EncryptedEndpoint, onReceive: () => void, onClose: (reason: string) => void) {
    this.#endpoint = endpoint;
    this.#socket = new WebSocket(relayUrl(host));
    this.#socket.binaryType = 'arraybuffer';
    this.#socket.onopen = () => this.flush();
    this.#socket.onmessage = (event) => {
      try {
        endpoint.receiveEncrypted(new Uint8Array(event.data as ArrayBuffer));
        this.flush();
        onReceive();
      } catch (error) {
        this.#shutdown(`connection to ${host} failed: ${error instanceof Error ? error.message : String(error)}`, onClose);
      }
    };
    this.#socket.onclose = () => this.#shutdown(`relay to ${host} closed`, onClose);
  }

  /** Sends whatever ciphertext the endpoint has produced. */
  flush(): void {
    const encrypted = this.#endpoint.takeEncrypted();
    if (encrypted.length > 0 && this.#socket.readyState === WebSocket.OPEN) this.#socket.send(encrypted);
  }

  close(): void {
    this.flush();
    this.#closed = true;
    this.#socket.onclose = null;
    this.#socket.close();
  }

  #shutdown(reason: string, onClose: (reason: string) => void): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.onclose = null;
    this.#socket.close();
    onClose(reason);
  }
}
