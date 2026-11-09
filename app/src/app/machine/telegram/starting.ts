// TDLib started and has not reported whether it holds a login. It has a minute to report; after that the instance
// is kept, stopped, with "Try again".

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import { afterReport, deleting, stopped } from './moves';
import { LOGIN_STATES, START_TIME_LIMIT_S, type TelegramEvent, type TelegramState } from './state';

type Starting = Variant<TelegramState, 'starting'>;

export const starting: VariantHandlers<TelegramState, 'starting', TelegramEvent, Context> = {
  'telegram/auth': (state, { auth }) => {
    if (auth._ === 'authorizationStateWaitTdlibParameters') return state;
    // A kept login that never completed: TDLib restores its QR code, whose token may have expired meanwhile
    // (AuthManager::load_state in third_party/td). Continuing it gains nothing, so the instance is given up.
    if (LOGIN_STATES.has(auth._) && (state.resumed || state.stop)) return deleting(state);
    if (auth._ === 'authorizationStateReady' && state.stop)
      return { kind: 'signing-out', method: state.method, instance: state.instance, attempt: state.attempt };
    if (auth._ === 'authorizationStateClosing' || auth._ === 'authorizationStateClosed') return deleting(state, true);
    return afterReport(state, auth);
  },
  'telegram/start-deadline': (state) =>
    stopped(state, `Telegram's library did not start within ${START_TIME_LIMIT_S} seconds.`),
  'telegram/start-failed': (state, event) => stopped(state, event.error),
  'telegram/fatal': (state, event) => (event.restarted ? state : deleting(state)),
  // A new instance holds no login yet; a kept one may, so TDLib's report decides.
  'telegram/stop': (state) => (state.resumed ? { ...state, stop: true } : deleting(state)),
  'telegram/forget': (state) => deleting(state),
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
};

export const startingWork = (state: Starting): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
  {
    kind: 'timer',
    key: `telegram-start:${state.instance}:${state.attempt}`,
    seconds: START_TIME_LIMIT_S,
    event: { type: 'telegram/start-deadline' },
  },
];
