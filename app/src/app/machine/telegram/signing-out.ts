// Ending the session: TDLib answers the logout once Telegram has (TelegramClient.logOut). The instance is forgotten
// only then; if the logout fails, or gets no answer within the request time limit, the login stays, with the error.

import { noAnswer, REQUEST_TIME_LIMIT_S } from '../../../core/time-limit';
import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import { deleting } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type SigningOut = Variant<TelegramState, 'signing-out'>;

const failed = (state: SigningOut, error: string): TelegramState => ({
  kind: 'signed-in',
  method: state.method,
  instance: state.instance,
  attempt: state.attempt,
  error: `Signing out of Telegram failed: ${error}`,
});

export const signingOut: VariantHandlers<TelegramState, 'signing-out', TelegramEvent, Context> = {
  'telegram/logged-out': (state) => deleting(state, true),
  'telegram/logout-failed': (state, event) => failed(state, event.error),
  'telegram/logout-deadline': (state) => failed(state, noAnswer('Telegram', REQUEST_TIME_LIMIT_S)),
  'telegram/forget': (state) => deleting(state),
};

export const signingOutWork = (state: SigningOut): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
  { kind: 'tdlib-logout', key: `tdlib-logout:${state.instance}:${state.attempt}`, instance: state.instance },
  {
    kind: 'timer',
    key: `telegram-logout:${state.instance}:${state.attempt}`,
    seconds: REQUEST_TIME_LIMIT_S,
    event: { type: 'telegram/logout-deadline' },
  },
];
