// The temporary linked device for one migration: linked by QR code, logged in, unlinked at the end.
// Its login, the storage service key and what it needs to message the account's other devices (the account's
// identity key pair and its registration ID) are kept by the workflow (`stored`) until the device is unlinked; the
// account's master key and entropy pool are never kept.

import { httpsRequest } from './http-client';
import { type LinkEvents, linkDevice, type LinkedAccount } from './link';
import { type Note, noteToSelfMessage } from './note-to-self';
import { fetchLatestStorageMessage, installStickerPacksMessage, OwnDevices } from './own-devices';
import { SignalSession } from './session';
import { HandshakeRefusedError, SocketClosedError } from './socket';
import { StorageClient } from './storage';
import type { ChatChannel, SendNoteOptions, SignalAccount } from './transport';
import { loadSignalWasm } from './wasm';

/** A linked device's login and storage service key, as kept between visits. */
export type StoredDevice = {
  aci: string;
  deviceId: number;
  password: string;
  storageServiceKey: Uint8Array;
  /** Absent for devices linked by an earlier version, which cannot message the other devices. */
  identityPublic?: Uint8Array;
  identityPrivate?: Uint8Array;
  registrationId?: number;
};

/** The server closes a removed device's connection with this code. */
const DEVICE_REMOVED = 4401;
/**
 * The server refuses a login it does not know (a removed device) at the WebSocket upgrade with this status
 * (Signal-Server WebSocketResourceProviderFactory, InvalidCredentialsException).
 */
const LOGIN_REFUSED = 403;

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
    const { aci, deviceId, password, storageServiceKey, identityPublic, identityPrivate, registrationId } = stored;
    return new SignalConnection({
      credentials: { aci, deviceId, password },
      storageServiceKey: storageServiceKey.slice(),
      identity:
        identityPublic && identityPrivate
          ? { publicKey: identityPublic.slice(), privateKey: identityPrivate.slice() }
          : undefined,
      registrationId,
    });
  }

  /** What is kept in the browser to use this device again after a reload. */
  get stored(): StoredDevice {
    const account = this.#account;
    return {
      ...account.credentials,
      storageServiceKey: account.storageServiceKey.slice(),
      identityPublic: account.identity?.publicKey.slice(),
      identityPrivate: account.identity?.privateKey.slice(),
      registrationId: account.registrationId,
    };
  }

  #ownDevices: OwnDevices | null = null;

  /** What sends to the account's other devices, with the sessions it has started with them. */
  async #toOwnDevices(): Promise<OwnDevices> {
    if (this.#removed) throw new DeviceRemovedError();
    const { aci, deviceId } = this.#account.credentials;
    const { identity, registrationId } = this.#account;
    if (!identity || registrationId === undefined)
      throw new Error('this device was linked by an earlier version of the app and cannot message your phone');
    await loadSignalWasm();
    if (this.#removed) throw new DeviceRemovedError();
    this.#ownDevices ??= new OwnDevices({ aci, deviceId, registrationId, identity });
    return this.#ownDevices;
  }

  /**
   * Tells the account's other devices to install these packs, then to read the storage service again, which
   * holds the packs' order. Two messages: Android acts on only one kind of request per sync message.
   */
  async announceStickerPacks(packs: { packId: Uint8Array; packKey: Uint8Array }[]): Promise<void> {
    const devices = await this.#toOwnDevices();
    await this.withChat(async (chat) => {
      if (packs.length > 0) await devices.send(chat, installStickerPacksMessage(packs));
      await devices.send(chat, fetchLatestStorageMessage());
    });
  }

  announceStorageChange(): Promise<void> {
    return this.announceStickerPacks([]);
  }

  async sendNoteToSelf(note: Note, options?: SendNoteOptions): Promise<void> {
    options?.cancel?.throwIfAborted();
    const devices = await this.#toOwnDevices();
    const content = noteToSelfMessage(this.#account.credentials.aci, note);
    // Not urgent, as Signal Desktop sends a transcript (sendSyncMessageOnly): the phone is not woken for each note.
    await this.withChat((chat) =>
      devices.send(chat, content, {
        timestamp: note.timestamp,
        urgent: false,
        cancel: options?.cancel,
        onWait: options?.onWait,
      }),
    );
  }

  /** Shows a QR code through `showQrCode` and waits until the phone has linked this device, or `cancel`. */
  static async link(
    showQrCode: (url: string) => void,
    deviceName: () => string,
    cancel: AbortSignal,
    onEvent?: LinkEvents,
  ): Promise<SignalConnection> {
    return new SignalConnection(await linkDevice(showQrCode, onEvent, deviceName, cancel));
  }

  get deviceId(): number {
    return this.#account.credentials.deviceId;
  }

  get isLinked(): boolean {
    return !this.#removed;
  }

  #markRemoved(notify: boolean): void {
    if (this.#removed) return;
    this.#removed = true;
    const active = this.#session;
    this.#session = null;
    if (active)
      void active.then(
        (session) => session.close(),
        () => undefined,
      );
    this.#ownDevices?.free();
    this.#ownDevices = null;
    this.#account.storageServiceKey.fill(0);
    this.#account.identity?.privateKey.fill(0);
    this.#account.credentials.password = '';
    if (notify) this.onUnlinked();
  }

  /** Closes any open connection, frees WASM sessions, and zeroes secrets in memory without unlinking on Signal. */
  dispose(): void {
    this.#markRemoved(false);
  }

  /**
   * The logged-in connection, opened again if it closed. A device removed while no connection was open (from the
   * phone while the page was closed) is refused at login, and counts as removed.
   */
  async session(): Promise<SignalSession> {
    if (this.#removed) throw new DeviceRemovedError();
    if (!this.#session) {
      const opening = SignalSession.open(this.#account.credentials).then(
        (session) => {
          if (this.#removed) {
            session.close();
            throw new DeviceRemovedError();
          }
          session.onUnexpectedClose = (code) => {
            if (this.#session === opening) this.#session = null;
            if (code === DEVICE_REMOVED) this.#markRemoved(true);
          };
          return session;
        },
        (error) => {
          if (!(error instanceof HandshakeRefusedError && error.status === LOGIN_REFUSED)) throw error;
          this.#markRemoved(true);
          throw new DeviceRemovedError();
        },
      );
      this.#session = opening;
      opening.catch(() => {
        if (this.#session === opening) this.#session = null;
      });
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
    const readKey = () => {
      if (this.#removed) throw new DeviceRemovedError();
      return this.#account.storageServiceKey.slice();
    };
    return this.withChat((chat) => StorageClient.open(chat, readKey, this.deviceId, this.https));
  }

  /**
   * Removes this device from the account and forgets its login. If Signal does not confirm, the device stays linked
   * and usable, and the error is thrown.
   */
  async unlink(): Promise<void> {
    if (this.#removed) return;
    try {
      const session = await this.session();
      try {
        await session.unlinkSelf();
      } finally {
        // unlinkSelf() always closes the underlying socket, so a subsequent retry must open a fresh session.
        this.#session = null;
      }
    } catch (error) {
      // Already removed: what unlinking is for has happened.
      if (!(error instanceof DeviceRemovedError)) throw error;
    }
    this.#markRemoved(true);
  }
}
