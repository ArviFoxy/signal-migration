// The states the Telegram login moves to from several others.

import type * as Td from 'tdlib-types';
import type { Variant } from '../core';
import { CLOSED_STATES, LOGIN_STATES, QR_REQUEST_STATES, type TelegramState } from './state';

type WithInstance = Exclude<TelegramState, { kind: 'off' }>;
type Running = Exclude<TelegramState, { kind: 'off' | 'creating' | 'deleting' }>;
type Login = Variant<TelegramState, 'login'>;

/** The instance is deleted from the browser, then the login is off. */
export const deleting = (state: WithInstance, signedOut = false, error: string | null = null): TelegramState => ({
  kind: 'deleting',
  method: state.method,
  instance: state.instance,
  signedOut,
  error,
});

/** TDLib does not run on the kept instance any more. */
export const stopped = (state: Running, error: string): TelegramState => ({
  kind: 'stopped',
  method: state.method,
  instance: state.instance,
  attempt: state.attempt,
  error,
});

/** With the QR method, TDLib is asked for a QR code once it waits for a phone number. */
export function withQrRequest(state: Login): Login {
  if (state.method !== 'qr' || state.request || state.qrRequested) return state;
  if (state.auth._ !== 'authorizationStateWaitPhoneNumber') return state;
  return {
    ...state,
    request: { _: 'requestQrCodeAuthentication', other_user_ids: [] },
    sent: state.sent + 1,
    qrRequested: true,
  };
}

/**
 * TDLib waits for the user. With the phone method, a QR code (asked for before the user switched) gives up the
 * instance, since TDLib cannot go back from a QR code to the phone form; the parent then starts a new login.
 */
export function login(state: Running, auth: Td.AuthorizationState): TelegramState {
  if (state.method === 'phone' && auth._ === 'authorizationStateWaitOtherDeviceConfirmation') return deleting(state);
  const previous = state.kind === 'login' ? state : null;
  return withQrRequest({
    kind: 'login',
    method: state.method,
    instance: state.instance,
    attempt: state.attempt,
    auth,
    request: previous?.request ?? null,
    sent: previous?.sent ?? 0,
    qrRequested: previous?.qrRequested ?? false,
    error: previous?.error ?? null,
  });
}

/**
 * What a report from TDLib means once it has reported before: it waits for the user (again), it is signed in, it
 * ends the session by itself, or it closed. A close this page did not ask for leaves the instance kept, since it may
 * still hold the login.
 */
export function afterReport(state: Running, auth: Td.AuthorizationState): TelegramState {
  if (LOGIN_STATES.has(auth._)) return login(state, auth);
  if (auth._ === 'authorizationStateReady')
    return { kind: 'saving', method: state.method, instance: state.instance, attempt: state.attempt };
  if (auth._ === 'authorizationStateLoggingOut')
    return { kind: 'ending-by-itself', method: state.method, instance: state.instance, attempt: state.attempt };
  if (CLOSED_STATES.has(auth._)) return stopped(state, 'the Telegram connection was closed');
  return state;
}

export { QR_REQUEST_STATES };
