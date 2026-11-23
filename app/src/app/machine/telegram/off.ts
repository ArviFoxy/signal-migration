// No instance: nothing is kept. The parent starts a login when the Telegram step shows.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { Work } from '../work';
import type { TelegramEvent, TelegramState } from './state';

export const off: ExhaustiveVariantHandlers<TelegramState, 'off', TelegramEvent, Context> = {
  'telegram/start': (state, _, context) => ({
    kind: 'creating',
    method: state.method,
    instance: `telegram-${context.nonce}`,
  }),
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
  'telegram/submit': IGNORE,
  'telegram/retry': (state) => ({ ...state, error: null }),
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
  'telegram/deleted': IGNORE,
  'record/saved': IGNORE,
  'record/failed': IGNORE,
};

export const offWork = (): Work[] => [];
