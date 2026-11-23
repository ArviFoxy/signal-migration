// TDLib waits for the user: the QR code to be scanned, a phone number, a code or a password. One login request is
// answered at a time.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { afterReport, deleting, withQrRequest } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type Login = Variant<TelegramState, 'login'>;

export const login: ExhaustiveVariantHandlers<TelegramState, 'login', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': (state, { method }) => {
    if (method === state.method) return state;
    // TDLib can switch from the phone form to a QR code, but not back from a QR code, so that switch gives up this
    // instance, and the parent starts a new login.
    if (method === 'phone' && state.auth._ === 'authorizationStateWaitOtherDeviceConfirmation')
      return deleting({ ...state, method });
    return withQrRequest({ ...state, method, error: null });
  },
  'telegram/submit': (state, event) =>
    state.request ? state : { ...state, request: event.query, sent: state.sent + 1, error: null },
  'telegram/retry': (state) =>
    withQrRequest({
      ...state,
      error: null,
      qrRequested: state.auth._ === 'authorizationStateWaitPassword' ? state.qrRequested : false,
    }),
  'telegram/stop': (state) => deleting(state),
  'telegram/forget': (state) => deleting(state),
  'telegram/auth': (state, { auth }) =>
    auth._ === 'authorizationStateClosing' || auth._ === 'authorizationStateClosed'
      ? deleting(state)
      : afterReport(state, auth),
  'telegram/fatal': (state, event) => (event.restarted ? state : deleting(state)),
  'telegram/start-failed': IGNORE,
  'telegram/start-deadline': IGNORE,
  'telegram/request-done': (state) => withQrRequest({ ...state, request: null }),
  'telegram/request-failed': (state, event) => ({ ...state, request: null, error: event.error }),
  'telegram/saved': IGNORE,
  'telegram/save-failed': IGNORE,
  'telegram/logged-out': IGNORE,
  'telegram/logout-failed': IGNORE,
  'telegram/logout-deadline': IGNORE,
  'telegram/ending-deadline': IGNORE,
  'telegram/deleted': IGNORE,
  'record/saved': IGNORE,
  'record/failed': IGNORE,
};

export const loginWork = (state: Login): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
  ...(state.request
    ? [
        {
          kind: 'tdlib-request' as const,
          key: `tdlib-request:${state.instance}:${state.attempt}:${state.sent}`,
          instance: state.instance,
          query: state.request,
        },
      ]
    : []),
];
