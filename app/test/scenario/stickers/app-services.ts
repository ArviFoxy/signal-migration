// The workflow's services (app/services.ts) over the scenario world, for testing the workflow: a Telegram login
// that the test completes by "scanning", the user's linked devices, the migration's simulated services, and a
// snapshot store that outlives a page, as the browser's storage does across a reload.

import type * as Td from 'tdlib-types';
import type { AppServices, LinkedDevice, SnapshotStore, TelegramSession } from '../../../src/app/services';
import type { Snapshot } from '../../../src/app/workflow';
import { PackIndex } from '../../../src/kinds/stickers/pack-index';
import { storageServiceKeyFromMasterKey } from '../../../src/wasm/signal_migration_wasm';
import { PageClock } from '../clock';
import { SimulatedAccount } from '../world';
import { simulatedConvert, type StickerUser } from './sticker-world';

/** What outlives a page in the user's browser: the snapshot, and whether TDLib keeps a Telegram session. */
export class Browser {
  snapshot: Snapshot | null = null;
  telegramSessionKept = false;
  readonly snapshots: SnapshotStore = {
    load: async () => (this.snapshot ? structuredClone(this.snapshot) : null),
    save: async (snapshot) => void (this.snapshot = structuredClone(snapshot)),
    clear: async () => void (this.snapshot = null),
  };
}

/** One page's services; `scanTelegramCode` completes a pending Telegram QR login. */
export function appServices(user: StickerUser, browser: Browser, options: { leaveAfterWaitOf?: number } = {}) {
  const { world } = user;
  let pendingLogin: (() => void) | null = null;

  const deviceFor = (account: SimulatedAccount): LinkedDevice => {
    const device: LinkedDevice = {
      deviceId: account.deviceId,
      https: account.https,
      stored: {
        aci: user.aci,
        deviceId: account.deviceId,
        password: 'simulated',
        storageServiceKey: account.storageServiceKey,
      },
      onUnlinked: () => undefined,
      get isLinked() {
        return account.isLinked;
      },
      withChat: (action) => account.withChat(action),
      storage: () => account.storage(),
      async unlink() {
        user.phone.unlink(account.deviceId);
        device.onUnlinked();
      },
    };
    return device;
  };

  const services: AppServices = {
    telegramApp: async () => ({ apiId: 1, apiHash: 'simulated' }),
    async startTelegram(_app, onAuthorizationState, resume) {
      const set = (state: object) => onAuthorizationState(state as Td.AuthorizationState);
      if (!resume) browser.telegramSessionKept = false;
      queueMicrotask(() =>
        set(
          browser.telegramSessionKept ? { _: 'authorizationStateReady' } : { _: 'authorizationStateWaitPhoneNumber' },
        ),
      );
      const session: TelegramSession = {
        invoke: (async (query: { _: string }) => {
          if (query._ !== 'requestQrCodeAuthentication') throw new Error(`not simulated: ${query._}`);
          set({ _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=simulated' });
          pendingLogin = () => {
            browser.telegramSessionKept = true;
            set({ _: 'authorizationStateReady' });
          };
          return { _: 'ok' };
        }) as unknown as Td.Invoke,
        source: user.stickers,
        async logOut() {
          browser.telegramSessionKept = false;
          set({ _: 'authorizationStateClosed' });
        },
        async close() {
          set({ _: 'authorizationStateClosed' });
        },
      };
      return session;
    },
    eraseTelegram: async () => void (browser.telegramSessionKept = false),
    async linkSignal(showQrCode) {
      showQrCode('sgnl://linkdevice?uuid=simulated');
      return deviceFor(user.linkDevice());
    },
    restoreSignal: (stored) =>
      deviceFor(new SimulatedAccount(world.signal, user.aci, stored.deviceId, stored.storageServiceKey.slice())),
    migration: () => ({
      clock: new PageClock(world.clock, options.leaveAfterWaitOf ?? null),
      convert: simulatedConvert,
      index: new PackIndex(world.index.backend, world.signal.manifestSource, world.index.pageSize),
    }),
    snapshots: browser.snapshots,
  };
  return {
    services,
    scanTelegramCode: () => {
      pendingLogin?.();
      pendingLogin = null;
    },
    /** The key that decrypts the account's whole storage, which the page must never keep. */
    masterKey: user.masterKey,
    storageServiceKey: storageServiceKeyFromMasterKey(user.masterKey),
  };
}
