// What the wizard needs from the outside world, as one object: the server's configuration, a Telegram login, a
// linked Signal device, and the migration's services. The app uses the real ones below; the demo page passes
// simulated ones.

import type * as Td from 'tdlib-types';
import { systemClock } from '../core/clock';
import { convertSticker } from '../kinds/stickers/convert';
import type { MigrationServices } from '../kinds/stickers/migration';
import { PackIndex } from '../kinds/stickers/pack-index';
import { type TelegramSource, telegramSource } from '../kinds/stickers/telegram-packs';
import { SignalConnection } from '../signal/connection';
import type { SignalAccount } from '../signal/transport';
import { type TelegramApp, TelegramClient } from '../telegram/client';

/** A Telegram login in progress or done. */
export interface TelegramSession {
  invoke: Td.Invoke;
  readonly source: TelegramSource;
  /** Ends the session on Telegram's side and erases local data. */
  logOut(): Promise<void>;
  /** Stops a login that never completed. */
  close(): Promise<void>;
}

/** The linked Signal device. */
export interface LinkedDevice extends SignalAccount {
  readonly deviceId: number;
  onUnlinked: () => void;
  unlink(): Promise<void>;
}

export type AppServices = {
  /** The Telegram app identity, or null when the server has none configured. */
  telegramApp(): Promise<TelegramApp | null>;
  startTelegram(
    app: TelegramApp,
    onAuthorizationState: (state: Td.AuthorizationState) => void,
  ): Promise<TelegramSession>;
  linkSignal(showQrCode: (url: string) => void, deviceName: () => string): Promise<LinkedDevice>;
  migration(): MigrationServices;
};

export const realServices: AppServices = {
  async telegramApp() {
    const response = await fetch('/v1/config');
    if (!response.ok) throw new Error(`reading this site's configuration answered ${response.status}`);
    return ((await response.json()) as { telegram: TelegramApp | null }).telegram;
  },
  async startTelegram(app, onAuthorizationState) {
    const client = await TelegramClient.start(app, onAuthorizationState);
    return {
      invoke: client.invoke,
      source: telegramSource(client),
      logOut: () => client.logOut(),
      close: () => client.close(),
    };
  },
  linkSignal: (showQrCode, deviceName) => SignalConnection.link(showQrCode, deviceName),
  migration: () => ({ clock: systemClock, convert: convertSticker, index: new PackIndex() }),
};
