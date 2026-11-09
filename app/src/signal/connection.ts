// The temporary linked device for one migration: linked by QR code, logged in, unlinked at the end.
// Its login and the storage service key (`stored`) are kept by the workflow until the migration is done or the
// user clears it; the account's master key is never kept.

import { httpsRequest } from './http-client';
import { type LinkEvents, linkDevice, type LinkedAccount } from './link';
import { SignalSession } from './session';
import { SocketClosedError } from './socket';
import { StorageClient } from './storage';
import type { ChatChannel, SignalAccount } from './transport';

/** A linked device's login and storage service key, as kept between visits. */
export type StoredDevice = { aci: string; deviceId: number; password: string; storageServiceKey: Uint8Array };

/** The server closes a removed device's connection with this code. */
const DEVICE_REMOVED = 4401;

export class DeviceRemovedError extends Error {
  constructor() {
    super('this device was unlinked from the Signal account');
  }
}

export class SignalConnection implements SignalAccount {
  readonly https = httpsRequest;
  #account: LinkedAccount;
  #session: Promise<SignalSession> | null = null;
  #removed = false;
  /** Called when the device stops being linked, whether unlinked here or from the phone. */
  onUnlinked: () => void = () => undefined;

  private constructor(account: LinkedAccount) {
    this.#account = account;
  }

  /** A device linked during an earlier visit. */
  static restore(stored: StoredDevice): SignalConnection {
    const { aci, deviceId, password, storageServiceKey } = stored;
    return new SignalConnection({
      credentials: { aci, deviceId, password },
      storageServiceKey: storageServiceKey.slice(),
    });
  }

  /** What is kept in the browser to use this device again after a reload. */
  get stored(): StoredDevice {
    return { ...this.#account.credentials, storageServiceKey: this.#account.storageServiceKey.slice() };
  }

  /** Shows a QR code through `showQrCode` and waits until the phone has linked this device. */
  static async link(
    showQrCode: (url: string) => void,
    deviceName: () => string,
    onEvent?: LinkEvents,
  ): Promise<SignalConnection> {
    return new SignalConnection(await linkDevice(showQrCode, onEvent, deviceName));
  }

  get deviceId(): number {
    return this.#account.credentials.deviceId;
  }

  get isLinked(): boolean {
    return !this.#removed;
  }

  #markRemoved(): void {
    if (this.#removed) return;
    this.#removed = true;
    this.#account.storageServiceKey.fill(0);
    this.#account.credentials.password = '';
    this.onUnlinked();
  }

  /** The logged-in connection, opened again if it closed. */
  async session(): Promise<SignalSession> {
    if (this.#removed) throw new DeviceRemovedError();
    if (!this.#session) {
      const opening = SignalSession.open(this.#account.credentials).then((session) => {
        session.onUnexpectedClose = (code) => {
          this.#session = null;
          if (code === DEVICE_REMOVED) this.#markRemoved();
        };
        return session;
      });
      this.#session = opening;
      opening.catch(() => (this.#session = null));
    }
    return this.#session;
  }

  /** Runs `action` with the session, opening it again once if the connection dropped meanwhile. */
  async withChat<T>(action: (chat: ChatChannel) => Promise<T>): Promise<T> {
    try {
      return await action(await this.session());
    } catch (error) {
      if (!(error instanceof SocketClosedError) || error.code === DEVICE_REMOVED) throw error;
      return action(await this.session());
    }
  }

  async storage(): Promise<StorageClient> {
    return this.withChat((chat) =>
      StorageClient.open(chat, this.#account.storageServiceKey, this.deviceId, this.https),
    );
  }

  /** Removes this device from the account and forgets its login. */
  async unlink(): Promise<void> {
    if (this.#removed) return;
    try {
      await (await this.session()).unlinkSelf();
    } finally {
      this.#session = null;
      this.#markRemoved();
    }
  }
}
