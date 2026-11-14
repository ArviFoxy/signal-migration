// The workflow's services (app/services.ts) over the scenario world, for testing the workflow.
//
// The simulated Telegram behaves like TDLib in the ways the workflow depends on:
// - Each instance's login lives in the page until it is saved with checkpoint() (or with syncTdlib(), which stands
//   for tdweb's periodic copy); a reload sees only what was saved.
// - QR and phone logins follow TDLib's rules: a phone number is refused while a QR code waits, a QR code can be
//   requested from the phone form.
// - logOut() answers once Telegram has ended the session; "closing" comes after it, and "closed" never comes.
// - A stopped instance can still send an update, which the workflow must ignore.
// - TDLib can stop after an internal error (crash()). With a login saved in the browser, the client restarts it and
//   the session goes on (telegram/client.ts); without one, the client stops and answers nothing more.
// The simulated Signal links a device only when the test scans the code, and can be cancelled meanwhile.
// The Telegram server side (which sessions are active) and the Signal account outlive pages; the browser's storage
// (Browser) outlives a reload.

import type * as Td from 'tdlib-types';
import type {
  AppServices,
  LinkedDevice,
  SnapshotStore,
  TelegramServices,
  TelegramSession,
} from '../../../src/app/services';
import { PackIndex } from '../../../src/kinds/stickers/pack-index';
import { LinkingCancelledError } from '../../../src/signal/link';
import { storageServiceKeyFromMasterKey } from '../../../src/wasm/signal_migration_wasm';
import { PageClock } from '../clock';
import { SimulatedAccount } from '../world';
import { simulatedConvert, simulatedPictures, type StickerUser } from './sticker-world';

/** A TDLib instance's data: the authorization it holds, and whether it was logging out. */
type InstanceData = { authorization: string | null; loggingOut: boolean };

/** Telegram's servers, for one user: the active sessions (authorizations) and the code a phone login needs. */
export class TelegramServer {
  readonly active = new Set<string>();
  #next = 0;
  static readonly CODE = '12345';

  authorize(): string {
    const authorization = `authorization-${++this.#next}`;
    this.active.add(authorization);
    return authorization;
  }
}

const servers = new WeakMap<StickerUser, TelegramServer>();
export const telegramServerOf = (user: StickerUser) => {
  if (!servers.has(user)) servers.set(user, new TelegramServer());
  return servers.get(user)!;
};

/** What outlives a page in the user's browser: the snapshot, and the TDLib instances' saved data. */
export class Browser {
  snapshot: unknown = null;
  readonly instances = new Map<string, InstanceData>();
  /** The instances running in the current page, by name: their live data, which syncTdlib() saves. */
  readonly running = new Map<string, InstanceData>();
  readonly snapshots: SnapshotStore = {
    load: async () => (this.snapshot ? structuredClone(this.snapshot) : null),
    save: async (snapshot) => void (this.snapshot = structuredClone(snapshot)),
    clear: async () => void (this.snapshot = null),
  };

  /** tdweb's periodic copy of every running instance's database. */
  syncTdlib(): void {
    for (const [name, live] of this.running) if (this.instances.has(name)) this.instances.set(name, { ...live });
  }

  /** Counts the pages opened in this browser; only the newest one runs. */
  page = 0;

  /** The page is closed: nothing runs any more, and nothing is saved at closing. */
  closePage(): void {
    this.running.clear();
    this.page++;
  }
}

const tdError = (code: number, message: string) => Object.assign(new Error(message), { code });

/** One page's services; the test plays the phone with scanTelegramCode and scanSignalCode. */
export function appServices(
  user: StickerUser,
  browser: Browser,
  options: {
    leaveAfterWaitOf?: number;
    withholdClosing?: boolean;
    /** TDLib starts but never reports a login state. */
    silentTelegram?: boolean;
    /** Telegram never answers a logout (no network, for example). */
    logOutNever?: boolean;
    /** Signal never answers an unlink. */
    unlinkNever?: boolean;
    /** How many times reading the migration server's configuration fails. */
    appFailures?: number;
    /** How many times reading the record from the browser fails. */
    loadFailures?: number;
    /** Writing the record to the browser fails. */
    saveFails?: boolean;
  } = {},
) {
  const { world } = user;
  const server = telegramServerOf(user);
  let instanceCount = browser.instances.size;
  let pendingTelegramScan: (() => void) | null = null;
  let pendingSignalScan: (() => void) | null = null;
  const started: {
    instance: string;
    disposed: boolean;
    crash: () => void;
    report: (state: Td.AuthorizationState['_']) => void;
  }[] = [];
  let appFailures = options.appFailures ?? 0;
  let loadFailures = options.loadFailures ?? 0;
  /** The connections to Signal devices this page made, by device ID. */
  const devices = new Map<number, LinkedDevice>();
  const page = browser.page;
  /** A closed page's work never finishes. */
  const whileOpen = <T>(action: () => Promise<T>): Promise<T> =>
    browser.page === page ? action() : new Promise<T>(() => undefined);

  const telegram: TelegramServices = {
    app: async () => {
      if (appFailures-- > 0) throw new Error("reading the migration server's configuration answered 503");
      return { apiId: 1, apiHash: 'simulated' };
    },
    newInstance: () => `telegram-${String(++instanceCount).padStart(16, '0')}`,
    start(_app, instance, onAuthorizationState, onFatalError) {
      if (!browser.instances.has(instance)) browser.instances.set(instance, { authorization: null, loggingOut: false });
      const live: InstanceData = { ...browser.instances.get(instance)! };
      browser.running.set(instance, live);
      let crashed = false;
      const record = {
        instance,
        disposed: false,
        crash() {
          const restarted = browser.instances.get(instance)?.authorization != null;
          if (!restarted) crashed = true;
          onFatalError('Aborted()', restarted);
        },
        /** TDLib reports `state` by itself. */
        report: (state: Td.AuthorizationState['_']) => set({ _: state }),
      };
      started.push(record);
      let auth: Td.AuthorizationState['_'] = 'authorizationStateWaitTdlibParameters';
      /** The instance runs until it is stopped or its page is closed; after that it does nothing more. */
      const alive = () => browser.running.get(instance) === live && !crashed;
      let lastState: object = { _: 'authorizationStateWaitTdlibParameters' };
      const set = (state: object) => {
        if (!alive() && !record.disposed) return;
        lastState = state;
        auth = (state as { _: Td.AuthorizationState['_'] })._;
        onAuthorizationState(state as Td.AuthorizationState);
      };
      const later = (action: () => void) => setTimeout(() => alive() && action(), 0);
      const finishLogout = () =>
        later(() => {
          if (live.authorization) server.active.delete(live.authorization);
          Object.assign(live, { authorization: null, loggingOut: false });
          if (!options.withholdClosing) later(() => set({ _: 'authorizationStateClosing' }));
        });
      later(() => {
        if (options.silentTelegram) return;
        if (live.loggingOut) {
          set({ _: 'authorizationStateLoggingOut' });
          finishLogout();
        } else if (live.authorization && server.active.has(live.authorization)) {
          set({ _: 'authorizationStateReady' });
        } else {
          live.authorization = null;
          set({ _: 'authorizationStateWaitPhoneNumber' });
        }
      });
      const signIn = () => {
        live.authorization = server.authorize();
        set({ _: 'authorizationStateReady' });
        return true;
      };
      const session: TelegramSession = {
        instance,
        invoke: (async (query: { _: string; code?: string }) => {
          if (record.disposed || crashed) throw new Error('the Telegram connection was closed');
          await new Promise((resolve) => setTimeout(resolve, 0));
          switch (query._) {
            case 'requestQrCodeAuthentication':
              if (auth !== 'authorizationStateWaitPhoneNumber' && auth !== 'authorizationStateWaitCode')
                throw tdError(400, 'Call to requestQrCodeAuthentication unexpected');
              set({ _: 'authorizationStateWaitOtherDeviceConfirmation', link: `tg://login?token=${instance}` });
              pendingTelegramScan = () =>
                alive() && auth === 'authorizationStateWaitOtherDeviceConfirmation' && signIn();
              break;
            case 'setAuthenticationPhoneNumber':
              if (auth !== 'authorizationStateWaitPhoneNumber' && auth !== 'authorizationStateWaitCode')
                throw tdError(400, 'Call to setAuthenticationPhoneNumber unexpected');
              set({ _: 'authorizationStateWaitCode', code_info: { phone_number: '+1 555 0100' } });
              break;
            case 'checkAuthenticationCode':
              if (auth !== 'authorizationStateWaitCode')
                throw tdError(400, 'Call to checkAuthenticationCode unexpected');
              if (query.code !== TelegramServer.CODE) throw tdError(400, 'PHONE_CODE_INVALID');
              signIn();
              break;
            case 'logOut':
              if (options.logOutNever) await new Promise(() => undefined);
              if (live.loggingOut) throw tdError(400, 'Already logging out');
              if (live.authorization) {
                live.loggingOut = true;
                set({ _: 'authorizationStateLoggingOut' });
                await new Promise((resolve) => setTimeout(resolve, 0));
                // A closed page never hears back.
                if (!alive()) await new Promise(() => undefined);
                server.active.delete(live.authorization);
                Object.assign(live, { authorization: null, loggingOut: false });
                if (!options.withholdClosing) later(() => set({ _: 'authorizationStateClosing' }));
              }
              break;
            default:
              throw new Error(`not simulated: ${query._}`);
          }
          return { _: 'ok' };
        }) as unknown as Td.Invoke,
        source: user.stickers,
        async checkpoint() {
          if (browser.instances.has(instance)) browser.instances.set(instance, { ...live });
        },
        logOut: async () => void (await session.invoke({ _: 'logOut' })),
        terminate() {
          record.disposed = true;
          if (browser.running.get(instance) === live) browser.running.delete(instance);
          // Updates still on their way from the stopped client (a refreshed QR code, then "closed"), arriving after
          // the next client has reported; the workflow must not listen to them any more.
          const last = lastState;
          let hops = 5;
          const arrive = () =>
            --hops > 0 ? setTimeout(arrive, 0) : (set(last), set({ _: 'authorizationStateClosed' }));
          setTimeout(arrive, 0);
        },
        async dispose() {
          session.terminate();
          browser.instances.delete(instance);
        },
      };
      return session;
    },
    instances: () => whileOpen(async () => [...browser.instances.keys()]),
    deleteInstance: (instance) => whileOpen(async () => void browser.instances.delete(instance)),
  };

  const deviceFor = (account: SimulatedAccount): LinkedDevice => {
    const device: LinkedDevice = {
      deviceId: account.deviceId,
      https: account.https,
      stored: {
        aci: user.aci,
        deviceId: account.deviceId,
        password: 'simulated',
        storageServiceKey: account.storageServiceKey,
        identityPublic: new Uint8Array(33),
        identityPrivate: new Uint8Array(32),
        registrationId: 1,
      },
      onUnlinked: () => undefined,
      get isLinked() {
        return account.isLinked;
      },
      withChat: (action) => account.withChat(action),
      storage: () => account.storage(),
      announceStickerPacks: (packs) => account.announceStickerPacks(packs),
      announceStorageChange: () => account.announceStorageChange(),
      async unlink() {
        if (options.unlinkNever) await new Promise(() => undefined);
        if (world.signal.failUnlinks > 0) {
          world.signal.failUnlinks--;
          throw new Error('the connection to Signal closed');
        }
        user.phone.unlink(account.deviceId);
        device.onUnlinked();
      },
    };
    devices.set(device.deviceId, device);
    return device;
  };

  const services: AppServices = {
    telegram,
    signal: {
      async link(showQrCode, _deviceName, cancel) {
        showQrCode('sgnl://linkdevice?uuid=simulated');
        await new Promise<void>((resolve, reject) => {
          pendingSignalScan = resolve;
          cancel.addEventListener('abort', () => reject(new LinkingCancelledError()), { once: true });
        });
        return deviceFor(user.linkDevice());
      },
      restore: (stored) =>
        deviceFor(new SimulatedAccount(world.signal, user.aci, stored.deviceId, stored.storageServiceKey.slice())),
    },
    migration: () => ({
      clock: new PageClock(world.clock, options.leaveAfterWaitOf ?? null),
      convert: simulatedConvert,
      index: new PackIndex(
        world.index.backend,
        world.signal.manifestSource,
        world.index.pageSize,
        world.signal.stickerSource,
      ),
      pictures: simulatedPictures,
    }),
    snapshots: {
      load: async () => {
        if (loadFailures-- > 0) throw new Error('the database is blocked');
        return browser.snapshots.load();
      },
      save: async (record) => {
        if (options.saveFails) throw new Error('the quota is exceeded');
        return whileOpen(() => browser.snapshots.save(record));
      },
      clear: () => whileOpen(() => browser.snapshots.clear()),
    },
    lock: async () => true,
  };
  return {
    services,
    server,
    /** Every TDLib instance this page started, and whether it was stopped. */
    started,
    devices,
    /** The phone scans the Telegram QR code on screen; false when none is waiting. */
    scanTelegramCode: () => {
      const scan = pendingTelegramScan;
      pendingTelegramScan = null;
      return scan?.() ?? false;
    },
    /** The phone scans the Signal QR code on screen; false when none is waiting. */
    scanSignalCode: () => {
      const scan = pendingSignalScan;
      pendingSignalScan = null;
      scan?.();
      return scan !== null;
    },
    /** The key that decrypts the account's whole storage, which the page must never keep. */
    masterKey: user.masterKey,
    storageServiceKey: storageServiceKeyFromMasterKey(user.masterKey),
  };
}
