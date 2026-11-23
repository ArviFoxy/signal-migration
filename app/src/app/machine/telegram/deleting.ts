// The instance is deleted from the browser (TDLib's worker stopped, its databases deleted); then the login is off.
// The deletion has a time limit, and what is left is deleted at the next visit.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import type { TelegramEvent, TelegramState } from './state';

type Deleting = Variant<TelegramState, 'deleting'>;

export const deletingHandlers: ExhaustiveVariantHandlers<TelegramState, 'deleting', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
  'telegram/submit': IGNORE,
  'telegram/retry': IGNORE,
  'telegram/stop': IGNORE,
  'telegram/forget': IGNORE,
  'telegram/auth': IGNORE,
  'telegram/fatal': IGNORE,
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
  'telegram/deleted': (state) => ({
    kind: 'off',
    method: state.method,
    signedOut: state.signedOut,
    error: state.error,
  }),
  'record/saved': IGNORE,
  'record/failed': IGNORE,
};

export const deletingWork = (state: Deleting): Work[] => [
  { kind: 'tdlib-delete', key: `tdlib-delete:${state.instance}`, instance: state.instance },
];
