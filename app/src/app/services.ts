// What the workflow needs from the outside world, as one object: the server's configuration, a Telegram login, a
// linked Signal device, the migration's services, and where the workflow keeps what it needs to resume. The app
// uses the real ones below; tests and fixtures pass simulated ones.

import { createStore, del, get, set } from 'idb-keyval';
import type * as Td from 'tdlib-types';
import { systemClock } from '../core/clock';
import { fetchWithTimeLimit, SERVER_TIME_LIMIT_S } from '../core/time-limit';
import { type FriendSource, phoneNumberSource } from '../kinds/friends/search';
import { type PeopleSource, peopleOf } from '../kinds/friends/telegram-people';
import { browserPictures } from '../kinds/stickers/compare-pictures';
import { convertSticker } from '../kinds/stickers/convert';
import type { MigrationServices } from '../kinds/stickers/migration';
import { PackIndex } from '../kinds/stickers/pack-index';
import { type TelegramSource, telegramSource } from '../kinds/stickers/telegram-packs';
import { SignalConnection, type StoredDevice } from '../signal/connection';
import { discoverAccounts } from '../signal/contact-discovery';
import type { SignalAccount } from '../signal/transport';
import {
  deleteTelegramInstance,
  newTelegramInstance,
  type TelegramApp,
  TelegramClient,
  telegramInstancesInBrowser,
} from '../telegram/client';
import type { Record } from './machine/record';

export type { StoredDevice };

/** One TDLib instance: a login in progress or done. */
export interface TelegramSession {
  readonly instance: string;
  invoke: Td.Invoke;
  readonly source: TelegramSource;
  /** The people of the account: its one-to-one chats, the members of its groups and its contact list. */
  readonly people: PeopleSource;
  /** Saves the login in this browser now. */
  checkpoint(): Promise<void>;
  /** Ends the session on Telegram's side; resolves once Telegram has answered. */
  logOut(): Promise<void>;
  /** Stops TDLib now and keeps what the instance stored in this browser, for TDLib to start on it again. */
  terminate(): void;
  /** Stops the instance now and deletes what it stored in this browser. */
  dispose(): Promise<void>;
}

export type TelegramServices = {
  /** The Telegram app identity, or null when the server has none configured. */
  app(): Promise<TelegramApp | null>;
  newInstance(): string;
  /**
   * Starts TDLib on an instance, new or kept from an earlier visit; `onAuthorizationState` gets each login state.
   * `onFatalError` gets TDLib's message when it stopped after an internal error, and whether it was restarted with the
   * saved login; when it was not, the session has ended.
   */
  start(
    app: TelegramApp,
    instance: string,
    onAuthorizationState: (state: Td.AuthorizationState) => void,
    onFatalError: (error: string, restarted: boolean) => void,
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

/** Where the app keeps its record between visits (machine/record.ts). */
export interface SnapshotStore {
  load(): Promise<unknown>;
  save(record: Record): Promise<void>;
  clear(): Promise<void>;
}

export type AppServices = {
  telegram: TelegramServices;
  signal: SignalServices;
  migration(): MigrationServices;
  friends: {
    /** The ways of finding the Signal accounts of Telegram people, over the linked device `account`. */
    sources(account: SignalAccount): FriendSource[];
  };
  snapshots: SnapshotStore;
  /**
   * Takes the lock that lets one tab run the migration, held until the page closes. Resolves true once held; with
   * `wait` false, resolves false at once when another tab holds it.
   */
  lock(wait: boolean): Promise<boolean>;
};

/** The record in this site's own IndexedDB database. */
function indexedDbSnapshots(): SnapshotStore {
  const store = createStore('signal-migration', 'workflow');
  return {
    load: async () => (await get<unknown>('snapshot', store)) ?? null,
    save: (record) => set('snapshot', record, store),
    clear: () => del('snapshot', store),
  };
}

/** The Web Locks API lock "signal-migration": a tab holds it while its page is open. */
function browserLock(wait: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request('signal-migration', { ifAvailable: !wait }, (lock) => {
      resolve(lock !== null);
      // Held for as long as the page lives.
      return lock ? new Promise<void>(() => undefined) : undefined;
    });
  });
}

export const realServices: AppServices = {
  telegram: {
    async app() {
      const response = await fetchWithTimeLimit('The migration server', SERVER_TIME_LIMIT_S, '/v1/config');
      if (!response.ok) throw new Error(`reading the migration server's configuration answered ${response.status}`);
      return ((await response.json()) as { telegram: TelegramApp | null }).telegram;
    },
    newInstance: newTelegramInstance,
    start(app, instance, onAuthorizationState, onFatalError) {
      const client = new TelegramClient(instance, app, onAuthorizationState, onFatalError);
      return {
        instance,
        invoke: client.invoke,
        source: telegramSource(client),
        people: peopleOf(client),
        checkpoint: () => client.checkpoint(),
        logOut: () => client.logOut(),
        terminate: () => client.terminate(),
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
  friends: {
    sources: (account) => [phoneNumberSource((phoneNumbers, known) => discoverAccounts(account, phoneNumbers, known))],
  },
  migration: () => ({
    clock: systemClock,
    convert: convertSticker,
    index: new PackIndex(),
    pictures: browserPictures,
  }),
  snapshots: indexedDbSnapshots(),
  lock: browserLock,
};
