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
import {
  deleteTelegramInstance,
  newTelegramInstance,
  type TelegramApp,
  TelegramClient,
  telegramInstancesInBrowser,
} from '../telegram/client';
import type { Snapshot } from './workflow';

export type { StoredDevice };

/** One TDLib instance: a login in progress or done. */
export interface TelegramSession {
  readonly instance: string;
  invoke: Td.Invoke;
  readonly source: TelegramSource;
  /** Saves the login in this browser now. */
  checkpoint(): Promise<void>;
  /** Ends the session on Telegram's side; resolves once Telegram has answered. */
  logOut(): Promise<void>;
  /** Stops the instance now and deletes what it stored in this browser. */
  dispose(): Promise<void>;
}

export type TelegramServices = {
  /** The Telegram app identity, or null when the server has none configured. */
  app(): Promise<TelegramApp | null>;
  newInstance(): string;
  /** Starts TDLib on an instance, new or kept from an earlier visit; `onAuthorizationState` gets each login state. */
  start(
    app: TelegramApp,
    instance: string,
    onAuthorizationState: (state: Td.AuthorizationState) => void,
  ): TelegramSession;
  /** The instances that have data in this browser. */
  instances(): Promise<string[]>;
  deleteInstance(instance: string): Promise<void>;
};

/** The linked Signal device. */
export interface LinkedDevice extends SignalAccount {
  readonly deviceId: number;
  /** What the workflow keeps to use the device again after a reload. */
  readonly stored: StoredDevice;
  onUnlinked: () => void;
  unlink(): Promise<void>;
}

export type SignalServices = {
  /** Shows a code through `showQrCode` and links when the phone scans it; `cancel` stops waiting. */
  link(showQrCode: (url: string) => void, deviceName: () => string, cancel: AbortSignal): Promise<LinkedDevice>;
  restore(stored: StoredDevice): LinkedDevice;
};

/** Where the workflow keeps its snapshot between visits. */
export interface SnapshotStore {
  load(): Promise<unknown>;
  save(snapshot: Snapshot): Promise<void>;
  clear(): Promise<void>;
}

export type AppServices = {
  telegram: TelegramServices;
  signal: SignalServices;
  migration(): MigrationServices;
  snapshots: SnapshotStore;
};

/** The snapshot in this site's own IndexedDB database. */
function indexedDbSnapshots(): SnapshotStore {
  const store = createStore('signal-migration', 'workflow');
  return {
    load: async () => (await get<unknown>('snapshot', store)) ?? null,
    save: (snapshot) => set('snapshot', snapshot, store),
    clear: () => del('snapshot', store),
  };
}

export const realServices: AppServices = {
  telegram: {
    async app() {
      const response = await fetch('/v1/config');
      if (!response.ok) throw new Error(`reading the migration server's configuration answered ${response.status}`);
      return ((await response.json()) as { telegram: TelegramApp | null }).telegram;
    },
    newInstance: newTelegramInstance,
    start(app, instance, onAuthorizationState) {
      const client = new TelegramClient(instance, app, onAuthorizationState);
      return {
        instance,
        invoke: client.invoke,
        source: telegramSource(client),
        checkpoint: () => client.checkpoint(),
        logOut: () => client.logOut(),
        dispose: () => client.dispose(),
      };
    },
    instances: telegramInstancesInBrowser,
    deleteInstance: deleteTelegramInstance,
  },
  signal: {
    link: (showQrCode, deviceName, cancel) => SignalConnection.link(showQrCode, deviceName, cancel),
    restore: (stored) => SignalConnection.restore(stored),
  },
  migration: () => ({ clock: systemClock, convert: convertSticker, index: new PackIndex() }),
  snapshots: indexedDbSnapshots(),
};
