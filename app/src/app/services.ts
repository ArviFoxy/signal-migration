// What the workflow needs from the outside world, as one object: the server's configuration, a Telegram login, a
// linked Signal device, the migration's services, and where the workflow keeps what it needs to resume. The app
// uses the real ones below; tests and the demo pass simulated ones.

import { createStore, del, get, set } from 'idb-keyval';
import type * as Td from 'tdlib-types';
import { systemClock } from '../core/clock';
import { convertSticker } from '../kinds/stickers/convert';
import type { MigrationServices } from '../kinds/stickers/migration';
import { PackIndex } from '../kinds/stickers/pack-index';
import { type TelegramSource, telegramSource } from '../kinds/stickers/telegram-packs';
import { SignalConnection, type StoredDevice } from '../signal/connection';
import type { SignalAccount } from '../signal/transport';
import { eraseTelegramData, type TelegramApp, TelegramClient } from '../telegram/client';
import type { Snapshot } from './workflow';

export type { StoredDevice };

/** A Telegram login in progress or done. */
export interface TelegramSession {
  invoke: Td.Invoke;
  readonly source: TelegramSource;
  /** Ends the session on Telegram's side and erases local data. */
  logOut(): Promise<void>;
  /** Stops TDLib without ending the session. */
  close(): Promise<void>;
}

/** The linked Signal device. */
export interface LinkedDevice extends SignalAccount {
  readonly deviceId: number;
  /** What the workflow keeps to use the device again after a reload. */
  readonly stored: StoredDevice;
  onUnlinked: () => void;
  unlink(): Promise<void>;
}

/** Where the workflow keeps its snapshot between visits. */
export interface SnapshotStore {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
  clear(): Promise<void>;
}

export type AppServices = {
  /** The Telegram app identity, or null when the server has none configured. */
  telegramApp(): Promise<TelegramApp | null>;
  /** Starts a Telegram session; with `resume`, the one kept in the browser. */
  startTelegram(
    app: TelegramApp,
    onAuthorizationState: (state: Td.AuthorizationState) => void,
    resume: boolean,
  ): Promise<TelegramSession>;
  /** Deletes a Telegram session kept in the browser without signing it out (when it can no longer be started). */
  eraseTelegram(): Promise<void>;
  linkSignal(showQrCode: (url: string) => void, deviceName: () => string): Promise<LinkedDevice>;
  restoreSignal(stored: StoredDevice): LinkedDevice;
  migration(): MigrationServices;
  snapshots: SnapshotStore;
};

/** The snapshot in this site's own IndexedDB database. */
function indexedDbSnapshots(): SnapshotStore {
  const store = createStore('signal-migration', 'workflow');
  return {
    load: async () => (await get<Snapshot>('snapshot', store)) ?? null,
    save: (snapshot) => set('snapshot', snapshot, store),
    clear: () => del('snapshot', store),
  };
}

export const realServices: AppServices = {
  async telegramApp() {
    const response = await fetch('/v1/config');
    if (!response.ok) throw new Error(`reading this site's configuration answered ${response.status}`);
    return ((await response.json()) as { telegram: TelegramApp | null }).telegram;
  },
  async startTelegram(app, onAuthorizationState, resume) {
    const client = await TelegramClient.start(app, onAuthorizationState, resume);
    return {
      invoke: client.invoke,
      source: telegramSource(client),
      logOut: () => client.logOut(),
      close: () => client.close(),
    };
  },
  eraseTelegram: eraseTelegramData,
  linkSignal: (showQrCode, deviceName) => SignalConnection.link(showQrCode, deviceName),
  restoreSignal: (stored) => SignalConnection.restore(stored),
  migration: () => ({ clock: systemClock, convert: convertSticker, index: new PackIndex() }),
  snapshots: indexedDbSnapshots(),
};
