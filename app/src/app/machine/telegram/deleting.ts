// The instance is deleted from the browser (TDLib's worker stopped, its databases deleted); then the login is off.
// The deletion has a time limit, and what is left is deleted at the next visit.

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import type { TelegramEvent, TelegramState } from './state';

type Deleting = Variant<TelegramState, 'deleting'>;

export const deletingHandlers: VariantHandlers<TelegramState, 'deleting', TelegramEvent, Context> = {
  'telegram/deleted': (state) => ({
    kind: 'off',
    method: state.method,
    signedOut: state.signedOut,
    error: state.error,
  }),
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
};

export const deletingWork = (state: Deleting): Work[] => [
  { kind: 'tdlib-delete', key: `tdlib-delete:${state.instance}`, instance: state.instance },
];
