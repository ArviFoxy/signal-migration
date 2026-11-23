// A new instance, being written down in the browser. TDLib starts on it only once the record holding it is written,
// so that a page closed at any moment leaves no instance that the next visit does not know.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { Work } from '../work';
import { deleting } from './moves';
import type { TelegramEvent, TelegramState } from './state';

export const creating: ExhaustiveVariantHandlers<TelegramState, 'creating', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
  'telegram/submit': IGNORE,
  'telegram/retry': IGNORE,
  'telegram/stop': (state) => deleting(state),
  'telegram/forget': (state) => deleting(state),
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
  'record/saved': (state, event) =>
    event.telegram === state.instance
      ? {
          kind: 'starting',
          method: state.method,
          instance: state.instance,
          attempt: 1,
          resumed: false,
          stop: false,
        }
      : state,
  'record/failed': (state, event) => ({
    kind: 'off',
    method: state.method,
    signedOut: false,
    error: `This browser could not keep the migration's progress: ${event.error}`,
  }),
};

export const creatingWork = (): Work[] => [];
