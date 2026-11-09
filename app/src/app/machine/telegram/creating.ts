// A new instance, being written down in the browser. TDLib starts on it only once the record holding it is written,
// so that a page closed at any moment leaves no instance that the next visit does not know.

import type { Context, VariantHandlers } from '../core';
import type { Work } from '../work';
import { deleting } from './moves';
import type { TelegramEvent, TelegramState } from './state';

export const creating: VariantHandlers<TelegramState, 'creating', TelegramEvent, Context> = {
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
  'telegram/stop': (state) => deleting(state),
  'telegram/forget': (state) => deleting(state),
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
};

export const creatingWork = (): Work[] => [];
