// Signed in; TDLib stays running for the migration and for reading packs, friends and saved messages.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { afterReport, deleting, stopped } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type SignedIn = Variant<TelegramState, 'signed-in'>;

export const signedIn: ExhaustiveVariantHandlers<TelegramState, 'signed-in', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': IGNORE,
  'telegram/submit': IGNORE,
  'telegram/retry': IGNORE,
  'telegram/stop': (state) => ({
    kind: 'signing-out',
    method: state.method,
    instance: state.instance,
    attempt: state.attempt,
  }),
  'telegram/forget': (state) => deleting(state),
  'telegram/auth': (state, { auth }) => (auth._ === 'authorizationStateReady' ? state : afterReport(state, auth)),
  'telegram/fatal': (state, event) => (event.restarted ? state : stopped(state, event.error)),
  'telegram/start-failed': IGNORE,
  'telegram/start-deadline': IGNORE,
  'telegram/request-done': IGNORE,
  'telegram/request-failed': IGNORE,
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

export const signedInWork = (state: SignedIn): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
];
