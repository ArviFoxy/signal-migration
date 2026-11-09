// TDLib waits for the user: the QR code to be scanned, a phone number, a code or a password. One login request is
// answered at a time.

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import { afterReport, deleting, QR_REQUEST_STATES, withQrRequest } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type Login = Variant<TelegramState, 'login'>;

export const login: VariantHandlers<TelegramState, 'login', TelegramEvent, Context> = {
  'telegram/auth': (state, { auth }) =>
    auth._ === 'authorizationStateClosing' || auth._ === 'authorizationStateClosed'
      ? deleting(state)
      : afterReport(state, auth),
  'telegram/submit': (state, event) =>
    state.request ? state : { ...state, request: event.query, sent: state.sent + 1, error: null },
  'telegram/request-done': (state) => ({ ...state, request: null }),
  'telegram/request-failed': (state, event) => ({ ...state, request: null, error: event.error }),
  'telegram/retry': (state) => withQrRequest({ ...state, error: null, qrRequested: false }),
  'telegram/use-method': (state, { method }) => {
    if (method === state.method) return state;
    // TDLib can switch from the phone form to a QR code, but not back from a QR code, so that switch gives up this
    // instance, and the parent starts a new login.
    if (method === 'phone' && state.auth._ === 'authorizationStateWaitOtherDeviceConfirmation')
      return deleting({ ...state, method });
    const next = { ...state, method, error: null };
    if (method === 'qr' && !state.request && QR_REQUEST_STATES.has(state.auth._))
      return {
        ...next,
        request: { _: 'requestQrCodeAuthentication' as const, other_user_ids: [] },
        sent: state.sent + 1,
        qrRequested: true,
      };
    return next;
  },
  'telegram/fatal': (state, event) => (event.restarted ? state : deleting(state)),
  'telegram/stop': (state) => deleting(state),
  'telegram/forget': (state) => deleting(state),
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
