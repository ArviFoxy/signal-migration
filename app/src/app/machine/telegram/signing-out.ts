// Ending the session: TDLib answers the logout once Telegram has (TelegramClient.logOut). The instance is forgotten
// only then (or if Telegram closes the session remotely); if the logout fails, hits a fatal error, or gets no answer
// within the request time limit, the login stays kept with the error.

import { noAnswer, REQUEST_TIME_LIMIT_S } from '../../../core/time-limit';
import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { deleting, stopped } from './moves';
import { CLOSED_STATES, type TelegramEvent, type TelegramState } from './state';

type SigningOut = Variant<TelegramState, 'signing-out'>;

const failed = (state: SigningOut, error: string): TelegramState => ({
  kind: 'signed-in',
  method: state.method,
  instance: state.instance,
  attempt: state.attempt,
  error: `Signing out of Telegram failed: ${error}`,
});

export const signingOut: ExhaustiveVariantHandlers<TelegramState, 'signing-out', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': IGNORE,
  'telegram/submit': IGNORE,
  'telegram/retry': IGNORE,
  'telegram/stop': IGNORE,
  'telegram/forget': (state) => deleting(state),
  'telegram/auth': (state, { auth }) => (CLOSED_STATES.has(auth._) ? deleting(state, true) : state),
  'telegram/fatal': (state, event) => (event.restarted ? state : stopped(state, event.error)),
  'telegram/start-failed': IGNORE,
  'telegram/start-deadline': IGNORE,
  'telegram/request-done': IGNORE,
  'telegram/request-failed': IGNORE,
  'telegram/saved': IGNORE,
  'telegram/save-failed': IGNORE,
  'telegram/logged-out': (state) => deleting(state, true),
  'telegram/logout-failed': (state, event) => failed(state, event.error),
  'telegram/logout-deadline': (state) => failed(state, noAnswer('Telegram', REQUEST_TIME_LIMIT_S)),
  'telegram/ending-deadline': IGNORE,
  'telegram/deleted': IGNORE,
  'record/saved': IGNORE,
  'record/failed': IGNORE,
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
