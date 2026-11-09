// TDLib ends the session by itself: it ended on another device, or a kept instance was signing out. TDLib first
// tells Telegram (AuthManager::log_out in third_party/td); once it has closed, or after a minute, the instance is
// deleted.

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import { deleting } from './moves';
import { CLOSED_STATES, ENDING_TIME_LIMIT_S, type TelegramEvent, type TelegramState } from './state';

type EndingByItself = Variant<TelegramState, 'ending-by-itself'>;

export const endingByItself: VariantHandlers<TelegramState, 'ending-by-itself', TelegramEvent, Context> = {
  'telegram/auth': (state, { auth }) => (CLOSED_STATES.has(auth._) ? deleting(state, true) : state),
  'telegram/ending-deadline': (state) => deleting(state, true),
  'telegram/forget': (state) => deleting(state),
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
