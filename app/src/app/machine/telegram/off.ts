// No instance: nothing is kept. The parent starts a login when the Telegram step shows.

import type { Context, VariantHandlers } from '../core';
import type { Work } from '../work';
import type { TelegramEvent, TelegramState } from './state';

export const off: VariantHandlers<TelegramState, 'off', TelegramEvent, Context> = {
  'telegram/start': (state, _, context) => ({
    kind: 'creating',
    method: state.method,
    instance: `telegram-${context.nonce}`,
  }),
  'telegram/retry': (state) => ({ ...state, error: null }),
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
};

export const offWork = (): Work[] => [];
