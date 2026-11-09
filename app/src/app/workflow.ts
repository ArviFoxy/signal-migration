// The workflow: the one source of truth for the app's state, and the only place that changes it. The view reads it
// and calls its actions; the router (ui/router.ts) mirrors its route in the address bar.
//
// What it needs to resume after a reload is kept in the browser as a snapshot (services.snapshots), saved after each
// change: the step, whether a Telegram session exists (TDLib keeps the session itself), the linked Signal device's
// login and storage service key, the packs the user deselected, and whether the migration started. Everything else
// is computed again from Telegram, the sticker pack index and Signal. When the migration is done, or the user clears
// everything, the snapshot is deleted, Telegram is signed out and the Signal device unlinked.

import type * as Td from 'tdlib-types';
import { type PackEntry, StickerMigration } from '../kinds/stickers/migration';
import type { AppServices, LinkedDevice, StoredDevice, TelegramSession } from './services';

export const ROUTES = ['start', 'telegram', 'packs', 'signal', 'review', 'migrate', 'done'] as const;
export type Route = (typeof ROUTES)[number];
export type ConnectionState = 'off' | 'wait' | 'on' | 'ended';

/** What is kept in the browser between visits. */
export type Snapshot = {
  version: 1;
  route: Route;
  telegram: boolean;
  signal: StoredDevice | null;
  /** Telegram sticker set IDs the user deselected. */
  deselected: string[];
  started: boolean;
};

const LOGIN_STATES = new Set<Td.AuthorizationState['_']>([
  'authorizationStateWaitPhoneNumber',
  'authorizationStateWaitOtherDeviceConfirmation',
  'authorizationStateWaitCode',
  'authorizationStateWaitEmailAddress',
  'authorizationStateWaitEmailCode',
  'authorizationStateWaitPassword',
  'authorizationStateWaitRegistration',
  'authorizationStateWaitPremiumPurchase',
]);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Workflow extends EventTarget {
  route: Route = 'start';
  error: string | null = null;
  /** While a migration kept in the browser is being restored after a reload. */
  restoring = false;
  telegramSession: TelegramSession | null = null;
  telegramAuth: Td.AuthorizationState | null = null;
  telegram: ConnectionState = 'off';
  device: LinkedDevice | null = null;
  signal: ConnectionState = 'off';
  unlinkedAutomatically = false;
  stickers: StickerMigration | null = null;
  #started = false;
  #telegramSettled: ((outcome: 'ready' | 'login') => void) | null = null;

  constructor(readonly services: AppServices) {
    super();
  }

  #changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  /** Runs an action; a failure is shown as the workflow's error rather than thrown. */
  async #act(action: () => Promise<void>): Promise<void> {
    this.error = null;
    try {
      await action();
    } catch (error) {
      this.error = message(error);
    } finally {
      this.#changed();
    }
  }

  #snapshot(): Snapshot {
    return {
      version: 1,
      route: this.route,
      telegram: this.telegramSession !== null,
      signal: this.device?.stored ?? null,
      deselected: (this.stickers?.entries ?? []).filter((entry) => !entry.selected).map((entry) => entry.pack.setId),
      started: this.#started,
    };
  }

  #save(): void {
    if (this.route === 'done' || this.restoring) return;
    this.services.snapshots.save(this.#snapshot()).catch((error) => {
      this.error = `This browser could not keep the migration's progress: ${message(error)}`;
      this.#changed();
    });
  }

  #go(route: Route): void {
    this.route = route;
    this.#save();
    this.#changed();
  }

  /** Whether the user can be on `route` now; the router refuses the others. */
  allowed(route: Route): boolean {
    switch (route) {
      case 'start':
      case 'telegram':
        return this.route !== 'done';
      case 'packs':
        return this.telegram === 'on' && this.stickers !== null;
      case 'signal':
        return this.stickers !== null && this.stickers.entries.length > 0;
      case 'review':
        return this.device !== null && this.stickers !== null;
      case 'migrate':
        return this.#started && this.device !== null;
      case 'done':
        return this.route === 'done';
    }
  }

  dismissError(): void {
    this.error = null;
    this.#changed();
  }

  /** Goes to a step the user asked for (Back buttons, the address bar); false when that step is not available. */
  navigate(route: Route): boolean {
    if (route === this.route || !this.allowed(route)) return false;
    this.#go(route);
    return true;
  }

  // Telegram

  /** Starts a fresh Telegram login. */
  start(): Promise<void> {
    return this.#act(async () => {
      this.#go('telegram');
      await this.#startTelegram(false);
    });
  }

  async #startTelegram(resume: boolean): Promise<void> {
    const app = await this.services.telegramApp();
    if (!app)
      throw new Error('This site has no Telegram app identity configured yet, so it cannot sign in to Telegram.');
    this.telegram = 'wait';
    this.telegramSession = await this.services.startTelegram(app, (state) => this.#onTelegramState(state), resume);
    this.#save();
  }

  #onTelegramState(state: Td.AuthorizationState): void {
    this.telegramAuth = state;
    if (state._ === 'authorizationStateReady') {
      this.telegram = 'on';
      this.#telegramSettled?.('ready');
      if (this.route === 'telegram') void this.#act(() => this.#readPacks([]));
    } else if (LOGIN_STATES.has(state._)) {
      this.#telegramSettled?.('login');
    }
    this.#changed();
  }

  /** Starts the Telegram login again (TDLib cannot switch from a QR login to a phone login). */
  restartTelegram(): Promise<void> {
    return this.#act(async () => {
      const old = this.telegramSession;
      Object.assign(this, { telegramSession: null, telegramAuth: null });
      await old?.close();
      await this.#startTelegram(false);
    });
  }

  async #signOutOfTelegram(): Promise<void> {
    const session = this.telegramSession;
    this.telegramSession = null;
    if (session) {
      await session.logOut();
      this.telegram = 'ended';
    }
    this.#save();
  }

  signOutOfTelegram(): Promise<void> {
    return this.#act(() => this.#signOutOfTelegram());
  }

  // Packs

  async #readPacks(deselected: string[]): Promise<void> {
    if (this.stickers?.entries.length) {
      this.#go('packs');
      return;
    }
    const stickers = new StickerMigration(this.services.migration());
    stickers.addEventListener('change', () => this.#changed());
    this.stickers = stickers;
    this.#go('packs');
    const source = this.telegramSession!.source;
    await stickers.readTelegram(source);
    for (const entry of stickers.entries) if (deselected.includes(entry.pack.setId)) stickers.setSelected(entry, false);
    stickers.lookUpInIndex().catch((error) => {
      this.error = message(error);
      this.#changed();
    });
    void stickers.loadPreviews(source);
  }

  /** Continues from the Telegram step once signed in. */
  continueFromTelegram(): Promise<void> {
    return this.#act(() => this.#readPacks([]));
  }

  setSelected(entries: PackEntry[], selected: boolean): void {
    for (const entry of entries) this.stickers?.setSelected(entry, selected);
    this.#save();
  }

  continueFromPacks(): void {
    this.stickers?.stopPreviews();
    this.#go(this.device ? 'review' : 'signal');
  }

  // Signal

  #attach(device: LinkedDevice): void {
    this.device = device;
    this.signal = 'on';
    device.onUnlinked = () => {
      this.device = null;
      this.signal = 'ended';
      if (this.route === 'review') this.route = 'signal';
      this.#save();
      this.#changed();
    };
  }

  /** Links the device: `showQrCode` shows the code to scan, `deviceName` is read once the phone has scanned it. */
  linkSignal(showQrCode: (url: string) => void, deviceName: () => string): Promise<void> {
    return this.#act(async () => {
      this.signal = 'wait';
      this.#changed();
      try {
        this.#attach(await this.services.linkSignal(showQrCode, deviceName));
      } catch (error) {
        this.signal = 'off';
        throw error;
      }
      await this.stickers!.lookUpInIndex();
      await this.stickers!.readSignal(this.device!);
      this.#go('review');
    });
  }

  unlinkSignal(): Promise<void> {
    return this.#act(async () => {
      await this.device?.unlink();
    });
  }

  // Migration

  async #runMigration(): Promise<void> {
    this.#started = true;
    this.#go('migrate');
    const stickers = this.stickers!;
    await stickers.lookUpInIndex();
    await stickers.run(this.device!, this.telegramSession!.source);
    if (stickers.selected.every((entry) => entry.state === 'in-signal')) await this.#finish();
  }

  startMigration(): Promise<void> {
    return this.#act(() => this.#runMigration());
  }

  /** Ends the migration: unlinks Signal, signs out of Telegram and deletes everything kept in the browser. */
  async #finish(): Promise<void> {
    this.#go('done');
    const errors: string[] = [];
    if (this.device) {
      await this.device.unlink().catch((error) => errors.push(`Unlinking Signal failed: ${message(error)}`));
      this.unlinkedAutomatically = true;
    }
    await this.#signOutOfTelegram().catch((error) => errors.push(`Signing out of Telegram failed: ${message(error)}`));
    await this.services.snapshots.clear();
    if (errors.length > 0) throw new Error(errors.join(' '));
  }

  finish(): Promise<void> {
    return this.#act(() => this.#finish());
  }

  /**
   * Clears everything: unlinks Signal, signs out of Telegram (or deletes its kept session), deletes the snapshot and
   * starts over. Uploads already made stay on Signal and in the index.
   */
  clearEverything(): Promise<void> {
    return this.#act(async () => {
      this.stickers?.pause();
      const errors: string[] = [];
      if (this.device)
        await this.device.unlink().catch((error) => errors.push(`Unlinking Signal failed: ${message(error)}`));
      if (this.telegramSession) {
        await this.#signOutOfTelegram().catch((error) =>
          errors.push(`Signing out of Telegram failed: ${message(error)}`),
        );
      } else {
        await this.services.eraseTelegram();
      }
      await this.services.snapshots.clear();
      this.#reset();
      if (errors.length > 0) throw new Error(errors.join(' '));
    });
  }

  /** Starts a new migration after one finished. */
  startOver(): void {
    this.#reset();
  }

  #reset(): void {
    Object.assign(this, {
      route: 'start',
      telegramSession: null,
      telegramAuth: null,
      telegram: 'off',
      device: null,
      signal: 'off',
      unlinkedAutomatically: false,
      stickers: null,
    });
    this.#started = false;
    this.#changed();
  }

  // Restoring after a reload

  /** Continues a migration kept in this browser, if there is one. */
  restore(): Promise<void> {
    return this.#act(async () => {
      const snapshot = await this.services.snapshots.load();
      if (!snapshot) return;
      this.restoring = true;
      this.#changed();
      try {
        this.#started = snapshot.started;
        if (snapshot.signal) this.#attach(this.services.restoreSignal(snapshot.signal));
        if (snapshot.telegram) {
          const settled = new Promise<'ready' | 'login'>((resolve) => (this.#telegramSettled = resolve));
          await this.#startTelegram(true);
          if ((await settled) === 'login') {
            this.route = 'telegram';
            return;
          }
          await this.#readPacks(snapshot.deselected);
          await this.stickers!.lookUpInIndex();
          if (this.device) await this.stickers!.readSignal(this.device);
        }
        this.route = this.allowed(snapshot.route) ? snapshot.route : this.stickers ? 'packs' : 'start';
      } finally {
        this.restoring = false;
        this.#telegramSettled = null;
        this.#save();
        this.#changed();
      }
      if (this.route === 'migrate') await this.#runMigration();
    });
  }
}
