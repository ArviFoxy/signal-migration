// A logged-in connection as the temporary linked device.
//
// The device's login goes into the Authorization header of the WebSocket handshake, inside the page's own TLS
// session to Signal, so neither the relay nor the browser ever handles it.

import { connectChat, SignalSocket, SocketClosedError } from './socket';

/** The temporary device's login. Held in memory only, for as long as the migration runs. */
export type DeviceCredentials = { aci: string; deviceId: number; password: string };

export const basicAuthorization = (username: string, password: string) => `Authorization: Basic ${btoa(`${username}:${password}`)}`;

export class SignalSession {
  #socket: SignalSocket;
  readonly deviceId: number;

  private constructor(socket: SignalSocket, deviceId: number) {
    this.#socket = socket;
    this.deviceId = deviceId;
  }

  static async open(credentials: DeviceCredentials): Promise<SignalSession> {
    const authorization = basicAuthorization(`${credentials.aci}.${credentials.deviceId}`, credentials.password);
    const socket = await connectChat('/v1/websocket/', '/v1/keepalive', [authorization]);
    // Messages queued for this device are acknowledged and dropped: it exists only to install and upload packs.
    socket.onServerRequest = () => 200;
    return new SignalSession(socket, credentials.deviceId);
  }

  set onUnexpectedClose(handler: (code: number) => void) {
    this.#socket.onUnexpectedClose = handler;
  }

  request(verb: string, path: string, options: { body?: Uint8Array; headers?: string[] } = {}) {
    return this.#socket.request(verb, path, options);
  }

  async requestJson<T>(verb: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(verb, path, {
      headers: body === undefined ? [] : ['content-type:application/json'],
      body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`${verb} ${path} answered ${response.status} ${response.message}`);
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  }

  async listDeviceIds(): Promise<number[]> {
    const { devices } = await this.requestJson<{ devices: { id: number }[] }>('GET', '/v1/devices');
    return devices.map((device) => device.id);
  }

  /** Removes this device from the account. The server then closes the socket with 4401, often before answering. */
  async unlinkSelf(): Promise<void> {
    try {
      const response = await this.request('DELETE', `/v1/devices/${this.deviceId}`);
      if (response.status !== 200 && response.status !== 204) throw new Error(`unlink answered ${response.status}`);
    } catch (error) {
      if (!(error instanceof SocketClosedError && error.code === 4401)) throw error;
    } finally {
      this.#socket.close();
    }
  }

  close(): void {
    this.#socket.close();
  }
}
