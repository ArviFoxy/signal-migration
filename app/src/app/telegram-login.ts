// The Telegram login, as a state machine that owns the page's one TDLib client.
//
//   off ──start──▶ starting ──TDLib asks for input──▶ login ──TDLib reports the login──▶ ready
//    ▲                 │  ▲                             │                                   │
//    │                 │  └──────── switch QR ↔ phone ──┘                                   │
//    └────────────────────────────── stopping ◀── sign out / give up ◀─────────────────────┘
//
// Two rules make the state depend only on what happened to the current client, never on the order of earlier
// clicks:
// - Operations run one at a time, from one queue. A click while another operation runs waits its turn.
// - Only the current client is heard. A client is replaced when the login restarts and dropped when it ends; any
//   update it still sends is ignored.
//
// The instance holding the login is kept by the workflow (`keep`). A new instance is kept before TDLib starts on it,
// so a page closed during the login leaves nothing unknown behind. The login is saved in the browser (checkpoint)
// before the state says "ready". Signing out waits for TDLib's answer to the logout request, never for TDLib to
// report that it closed.

import type * as Td from 'tdlib-types';
import type { TelegramApp } from '../telegram/client';
import type { TelegramServices, TelegramSession } from './services';

export type LoginMethod = 'qr' | 'phone';

export type TelegramState =
  /** No client. `signedOut`: a session ended during this visit. */
  | { kind: 'off'; signedOut: boolean }
  /** A client is starting, or continuing a kept login, and TDLib has not said yet whether it is signed in. */
  | { kind: 'starting' }
  /** TDLib waits for the user: the QR code to be scanned, a phone number, a code or a password. */
  | { kind: 'login'; auth: Td.AuthorizationState }
  | { kind: 'ready'; session: TelegramSession }
  /** Signing out, or giving up a login. */
  | { kind: 'stopping' };

/** TDLib's states in which it waits for the user. */
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

/**
 * TDLib's states once a session has ended: logged out here, from another device, or by Telegram. Before them,
 * "logging out" means TDLib is still telling Telegram (AuthManager::log_out and destroy_auth_keys in third_party/td).
 */
const ENDED_STATES = new Set<Td.AuthorizationState['_']>(['authorizationStateClosing', 'authorizationStateClosed']);

/** States from which TDLib accepts a request for a QR code (AuthManager::request_qr_code_authentication). */
const QR_REQUEST_STATES = new Set<Td.AuthorizationState['_']>([
  'authorizationStateWaitPhoneNumber',
  'authorizationStateWaitCode',
  'authorizationStateWaitEmailAddress',
  'authorizationStateWaitEmailCode',
  'authorizationStateWaitPassword',
  'authorizationStateWaitRegistration',
]);

/** How long to wait for an ended instance's databases to be deleted; what is left is deleted at the next start. */
const DISPOSE_TIMEOUT_MS = 5000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type LoginQuery = Parameters<TelegramSession['invoke']>[0];

export class TelegramLogin extends EventTarget {
  state: TelegramState = { kind: 'off', signedOut: false };
  method: LoginMethod = 'qr';
  /** Why the last operation failed (a wrong code, no network), until the next one starts. */
  error: string | null = null;
  /** What happened to TDLib that the user should know, until dismissed. */
  notice: string | null = null;
  /** While a login request (phone number, code, password) is being answered. */
  sending = false;
  /** The current client; updates from any other are ignored. */
  #client: TelegramSession | null = null;
  #app: TelegramApp | null = null;
  #qrRequested = false;
  /** The current client continues a kept instance and has not reported its state yet. */
  #resumed = false;
  /** TDLib is ending the session by itself (ended elsewhere, or a kept instance's logout); it must not be stopped. */
  #endingByItself = false;
  /** The current client's last authorization state, and a promise kept once it has reported one. */
  #auth: Td.AuthorizationState | null = null;
  #reported: Promise<void> = Promise.resolve();
  #markReported: () => void = () => undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly services: TelegramServices,
    /** Keeps `instance` in the browser, or nothing when null; resolves once written. */
    private readonly keep: (instance: string | null) => Promise<void>,
  ) {
    super();
  }

  /** The instance whose login the workflow keeps: the current client's, until it ends. */
  get instance(): string | null {
    return this.#client?.instance ?? null;
  }

  get session(): TelegramSession | null {
    return this.state.kind === 'ready' ? this.state.session : null;
  }

  #set(state: TelegramState): void {
    this.state = state;
    this.#changed();
  }

  #changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  /** Runs `operation` after every operation queued before it; its failure is kept in `error`. */
  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = async () => {
      try {
        await operation();
      } catch (error) {
        this.error = message(error);
        this.#changed();
      }
    };
    this.#queue = this.#queue.then(run);
    return this.#queue;
  }

  async #appIdentity(): Promise<TelegramApp> {
    this.#app ??= await this.services.app();
    if (!this.#app)
      throw new Error(
        'The migration server has no Telegram app identity configured yet, so signing in to Telegram is not possible.',
      );
    return this.#app;
  }

  /** Starts TDLib on `instance` and makes it the current client. */
  #open(app: TelegramApp, instance: string): void {
    this.#qrRequested = false;
    this.#resumed = false;
    this.#endingByItself = false;
    this.#auth = null;
    this.#reported = new Promise((resolve) => (this.#markReported = resolve));
    const client: TelegramSession = this.services.start(
      app,
      instance,
      (auth) => this.#onUpdate(client, auth),
      (error, restarted) => this.#onFatalError(client, error, restarted),
    );
    this.#client = client;
    this.#set({ kind: 'starting' });
  }

  /** Stops a client that is no longer current and deletes its data, giving up after a while. */
  async #dispose(client: TelegramSession): Promise<void> {
    await Promise.race([
      client.dispose().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
    ]);
  }

  /** Starts a new login. Does nothing while a client exists. */
  start(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.state.kind !== 'off') return;
      this.error = null;
      const app = await this.#appIdentity();
      const instance = this.services.newInstance();
      // Kept before TDLib starts, so that the next visit finds this login however this page ends.
      await this.keep(instance);
      this.#open(app, instance);
    });
  }

  /** Continues the login kept in `instance` by an earlier visit. */
  resume(instance: string): Promise<void> {
    return this.#enqueue(async () => {
      if (this.state.kind !== 'off') return;
      this.#open(await this.#appIdentity(), instance);
      this.#resumed = true;
    });
  }

  /** Replaces the current client with a new instance, for a fresh login. */
  async #startFresh(client: TelegramSession): Promise<void> {
    if (client !== this.#client) return;
    this.#client = null;
    this.#set({ kind: 'stopping' });
    await this.#dispose(client);
    const instance = this.services.newInstance();
    await this.keep(instance);
    this.#open(await this.#appIdentity(), instance);
  }

  #onUpdate(client: TelegramSession, auth: Td.AuthorizationState): void {
    if (client !== this.#client) return;
    this.#auth = auth;
    if (auth._ !== 'authorizationStateWaitTdlibParameters') this.#markReported();
    const resumed = this.#resumed && auth._ !== 'authorizationStateWaitTdlibParameters';
    if (resumed) this.#resumed = false;
    if (LOGIN_STATES.has(auth._)) {
      if (this.state.kind === 'stopping') return;
      // A kept login that never completed: TDLib restores its QR code, whose token may have expired meanwhile
      // (AuthManager::load_state in third_party/td). Continuing it gains nothing, so a new one starts.
      if (resumed) {
        void this.#enqueue(() => this.#startFresh(client));
        return;
      }
      this.#set({ kind: 'login', auth });
      if (auth._ === 'authorizationStateWaitPhoneNumber' && this.method === 'qr' && !this.#qrRequested) {
        this.#qrRequested = true;
        void this.#enqueue(() => this.#requestQrCode(client));
      }
    } else if (auth._ === 'authorizationStateReady') {
      void this.#enqueue(async () => {
        if (client !== this.#client) return;
        this.error = null;
        try {
          await client.checkpoint();
        } catch (error) {
          this.error = `This browser could not save the Telegram login, so a reload will ask to sign in again: ${message(error)}`;
        }
        if (client === this.#client) this.#set({ kind: 'ready', session: client });
      });
    } else if (auth._ === 'authorizationStateLoggingOut') {
      // Ended elsewhere, or a kept instance that was still signing out: TDLib finishes telling Telegram first.
      if (this.state.kind !== 'stopping') {
        this.#endingByItself = true;
        this.#set({ kind: 'stopping' });
      }
    } else if (ENDED_STATES.has(auth._)) {
      void this.#enqueue(() => this.#ended(client, true));
    }
  }

  /**
   * TDLib stopped after an internal error. With a saved login, the client restarted it and the login goes on.
   * Without one, the client has stopped and the unfinished login ends; a stop waiting for its first report goes on,
   * and the workflow starts a new login where it starts one.
   */
  #onFatalError(client: TelegramSession, error: string, restarted: boolean): void {
    if (client !== this.#client) return;
    this.notice = restarted
      ? `Telegram's library stopped after an internal error and was restarted. (TDLib: ${error})`
      : `Telegram's library stopped after an internal error. (TDLib: ${error})`;
    if (!restarted) {
      this.#markReported();
      void this.#enqueue(() => this.#ended(client, false));
    }
    this.#changed();
  }

  /**
   * The client ended without this page asking it to: the session ended (from another device, or by a kept
   * instance's logout), or TDLib stopped before a login was saved.
   */
  async #ended(client: TelegramSession, signedOut: boolean): Promise<void> {
    if (client !== this.#client) return;
    this.#client = null;
    await this.keep(null);
    this.#set({ kind: 'off', signedOut });
    await this.#dispose(client);
  }

  async #requestQrCode(client: TelegramSession): Promise<void> {
    if (client !== this.#client || this.method !== 'qr') return;
    if (this.state.kind !== 'login' || !QR_REQUEST_STATES.has(this.state.auth._)) return;
    await client.invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
  }

  /**
   * Signs in by QR code or by phone number. TDLib can switch from the phone form to a QR code, but not back from a
   * QR code, so that switch starts a new instance.
   */
  useMethod(method: LoginMethod): Promise<void> {
    return this.#enqueue(async () => {
      if (method === this.method) return;
      this.method = method;
      this.error = null;
      this.#changed();
      const client = this.#client;
      if (this.state.kind !== 'login' || !client) return;
      if (method === 'qr') {
        await this.#requestQrCode(client);
      } else if (this.state.auth._ === 'authorizationStateWaitOtherDeviceConfirmation') {
        await this.#startFresh(client);
      }
    });
  }

  /** Sends one login request (phone number, code, password); a refusal is kept in `error`. */
  submit(query: LoginQuery): Promise<void> {
    return this.#enqueue(async () => {
      const client = this.#client;
      if (this.state.kind !== 'login' || !client) return;
      this.error = null;
      this.sending = true;
      this.#changed();
      try {
        await client.invoke(query);
      } finally {
        this.sending = false;
        this.#changed();
      }
    });
  }

  /**
   * Ends the login: signs out of Telegram when signed in, or gives up a login in progress. The kept instance is
   * forgotten only after Telegram has answered the logout; if it does not, the session stays and the error is kept.
   */
  stop(): Promise<void> {
    return this.#enqueue(async () => {
      const client = this.#client;
      if (!client) return;
      // Whether TDLib holds a session is known once it has reported its state; a kept instance may also be in the
      // middle of a logout, which TDLib finishes by itself.
      await this.#reported;
      // A logout TDLib runs by itself ends with "closing"; stopping TDLib before that could leave the session open.
      if (client !== this.#client || this.#endingByItself) return;
      const signedIn = this.#auth?._ === 'authorizationStateReady';
      const previous = this.state;
      this.error = null;
      this.#set({ kind: 'stopping' });
      if (signedIn) {
        try {
          await client.logOut();
        } catch (error) {
          this.#set(previous);
          throw error;
        }
      }
      this.#client = null;
      await this.keep(null);
      this.#set({ kind: 'off', signedOut: signedIn });
      await this.#dispose(client);
    });
  }

  /** Clears a failed start, so that the login can start again. */
  retry(): void {
    this.error = null;
    this.#changed();
  }

  /** Waits until every operation queued so far has run. */
  settled(): Promise<void> {
    return this.#queue;
  }
}
