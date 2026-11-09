// Not everything could be ended. "Try again" ends the failed parts again; "Forget it" deletes a part from the
// browser without ending it, and the user ends it from the phone.

import type { Context, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import { signalTransition } from '../signal';
import { telegramTransition } from '../telegram';
import { beginEnding } from './session';
import type { AppState } from './state';

export const endFailed: VariantHandlers<AppState, 'end-failed', AppEvent, Context> = {
  'end/retry': (state, _, context) => beginEnding(state, state.reason, context),
  'end/forget': (state, event, context) =>
    event.part === 'telegram'
      ? {
          ...state,
          telegram: telegramTransition(state.telegram, { type: 'telegram/forget' }, context),
          telegramError: null,
        }
      : { ...state, signal: signalTransition(state.signal, { type: 'signal/forget' }, context), signalError: null },
};
