// TDLib ends the session by itself: it ended on another device, or a kept instance was signing out. TDLib first
// tells Telegram (AuthManager::log_out in third_party/td); once it has closed, stops fatally, or after a minute,
// the instance is deleted.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { deleting } from './moves';
import { CLOSED_STATES, ENDING_TIME_LIMIT_S, type TelegramEvent, type TelegramState } from './state';

type EndingByItself = Variant<TelegramState, 'ending-by-itself'>;

export const endingByItself: ExhaustiveVariantHandlers<TelegramState, 'ending-by-itself', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': IGNORE,
  'telegram/submit': IGNORE,
  'telegram/retry': IGNORE,
  'telegram/stop': IGNORE,
  'telegram/forget': (state) => deleting(state),
  'telegram/auth': (state, { auth }) => (CLOSED_STATES.has(auth._) ? deleting(state, true) : state),
  'telegram/fatal': (state, event) => (event.restarted ? state : deleting(state, true)),
  'telegram/start-failed': IGNORE,
  'telegram/start-deadline': IGNORE,
  'telegram/request-done': IGNORE,
  'telegram/request-failed': IGNORE,
  'telegram/saved': IGNORE,
  'telegram/save-failed': IGNORE,
  'telegram/logged-out': IGNORE,
  'telegram/logout-failed': IGNORE,
  'telegram/logout-deadline': IGNORE,
  'telegram/ending-deadline': (state) => deleting(state, true),
  'telegram/deleted': IGNORE,
  'record/saved': IGNORE,
  'record/failed': IGNORE,
};

export const endingByItselfWork = (state: EndingByItself): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
  {
    kind: 'timer',
    key: `telegram-ending:${state.instance}:${state.attempt}`,
    seconds: ENDING_TIME_LIMIT_S,
    event: { type: 'telegram/ending-deadline' },
  },
];
