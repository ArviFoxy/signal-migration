// The Telegram login: its states and events.
//
//   off ─start─▶ creating ─instance saved─▶ starting ─TDLib asks for input─▶ login ─signed in─▶ saving ─▶ signed-in
//                                             │  ▲                                                          │
//                     no report in 60 s ─▶ stopped ─Try again─┘                                  sign out ─▶ signing-out
//   deleting ◀── a login given up, a session that ended, or one forgotten ◀──────────────────────────────────┘
//   deleting ─▶ off
//
// An instance is written down in the browser before TDLib starts on it (creating), and forgotten only once its
// session is known to have ended (deleting), so that a page closed at any moment leaves nothing unknown behind.
// `stopped` keeps an instance whose TDLib does not run (it did not start, or it stopped by itself): it may still hold
// a login, which "Try again" continues and a sign-out ends.

import type * as Td from 'tdlib-types';
export type LoginMethod = 'qr' | 'phone';

/** The requests a login sends to TDLib. */
export type LoginQuery =
  | Td.requestQrCodeAuthentication
  | Td.setAuthenticationPhoneNumber
  | Td.checkAuthenticationCode
  | Td.setAuthenticationEmailAddress
  | Td.checkAuthenticationEmailCode
  | Td.checkAuthenticationPassword
  | Td.resendAuthenticationCode
  | Td.registerUser;

/** What every state keeps: how the user chose to sign in. */
type Base = { method: LoginMethod };

/** TDLib runs on `instance`; `attempt` counts its starts there, so that each start is new work. */
type Running = Base & { instance: string; attempt: number };

export type TelegramState =
  /** No instance. `signedOut`: a session ended during this visit. `error`: why the last attempt failed. */
  | (Base & { kind: 'off'; signedOut: boolean; error: string | null })
  /** A new instance, being written down in the browser. */
  | (Base & { kind: 'creating'; instance: string })
  /**
   * TDLib started and has not reported whether it holds a login. `resumed`: an instance kept by an earlier visit or
   * an earlier attempt. `stop`: the user or the end of the migration asked to sign out meanwhile.
   */
  | (Running & { kind: 'starting'; resumed: boolean; stop: boolean })
  /**
   * TDLib waits for the user: the QR code to be scanned, a phone number, a code or a password. `request`: the login
   * request being answered; `sent` counts the requests, so that each is new work. `error`: why the last one failed.
   */
  | (Running & {
      kind: 'login';
      auth: Td.AuthorizationState;
      request: LoginQuery | null;
      sent: number;
      qrRequested: boolean;
      error: string | null;
    })
  /** Signed in; the login is being saved in the browser. */
  | (Running & { kind: 'saving' })
  | (Running & { kind: 'signed-in'; error: string | null })
  | (Running & { kind: 'signing-out' })
  /** TDLib ends the session by itself: it ended elsewhere, or a kept instance was signing out. */
  | (Running & { kind: 'ending-by-itself' })
  /** TDLib does not run on the kept instance, which may hold a login. `error`: why. */
  | (Running & { kind: 'stopped'; error: string })
  /** The instance is being deleted from the browser; then off. */
  | (Base & { kind: 'deleting'; instance: string; signedOut: boolean; error: string | null });

export type TelegramEvent =
  // From the parent machine.
  | { type: 'telegram/start' }
  // From the user.
  | { type: 'telegram/use-method'; method: LoginMethod }
  | { type: 'telegram/submit'; query: LoginQuery }
  | { type: 'telegram/retry' }
  /** Sign out: the user's, or the end of the migration's. */
  | { type: 'telegram/stop' }
  /** Delete the instance from the browser without ending its session. */
  | { type: 'telegram/forget' }
  // From TDLib and the work around it.
  | { type: 'telegram/auth'; auth: Td.AuthorizationState }
  | { type: 'telegram/fatal'; error: string; restarted: boolean }
  | { type: 'telegram/start-failed'; error: string }
  | { type: 'telegram/start-deadline' }
  | { type: 'telegram/request-done' }
  | { type: 'telegram/request-failed'; error: string }
  | { type: 'telegram/saved' }
  | { type: 'telegram/save-failed'; error: string }
  | { type: 'telegram/logged-out' }
  | { type: 'telegram/logout-failed'; error: string }
  | { type: 'telegram/logout-deadline' }
  | { type: 'telegram/ending-deadline' }
  | { type: 'telegram/deleted' }
  // From the browser's storage: the record was written (with this instance, or none), or could not be.
  | { type: 'record/saved'; telegram: string | null }
  | { type: 'record/failed'; error: string };

/** How long TDLib may take to report whether it holds a login. */
export const START_TIME_LIMIT_S = 60;
/** How long TDLib may take to end a session it ends by itself. */
export const ENDING_TIME_LIMIT_S = 60;

/** TDLib's states in which it waits for the user. */
export const LOGIN_STATES = new Set<Td.AuthorizationState['_']>([
  'authorizationStateWaitPhoneNumber',
  'authorizationStateWaitOtherDeviceConfirmation',
  'authorizationStateWaitCode',
  'authorizationStateWaitEmailAddress',
  'authorizationStateWaitEmailCode',
  'authorizationStateWaitPassword',
  'authorizationStateWaitRegistration',
  'authorizationStateWaitPremiumPurchase',
]);

/** States from which TDLib accepts a request for a QR code (AuthManager::request_qr_code_authentication). */
export const QR_REQUEST_STATES = new Set<Td.AuthorizationState['_']>([
  'authorizationStateWaitPhoneNumber',
  'authorizationStateWaitCode',
  'authorizationStateWaitEmailAddress',
  'authorizationStateWaitEmailCode',
  'authorizationStateWaitPassword',
  'authorizationStateWaitRegistration',
]);

/** TDLib's states once it closed: after a logout, or when it was closed. */
export const CLOSED_STATES = new Set<Td.AuthorizationState['_']>([
  'authorizationStateClosing',
  'authorizationStateClosed',
]);

/** The instance the login keeps in the browser, if any. */
export function keptInstance(state: TelegramState): string | null {
  return state.kind === 'off' || state.kind === 'deleting' ? null : state.instance;
}
