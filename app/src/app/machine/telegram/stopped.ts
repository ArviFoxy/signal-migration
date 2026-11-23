// TDLib does not run on the kept instance: it did not start, or it closed by itself. The instance may still hold a
// login, so it stays kept: "Try again" starts TDLib on it again, and a sign-out starts it to end the session.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { deleting } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type Stopped = Variant<TelegramState, 'stopped'>;

const restart = (state: Stopped, stop: boolean): TelegramState => ({
  kind: 'starting',
  method: state.method,
  instance: state.instance,
  attempt: state.attempt + 1,
  resumed: true,
  stop,
});

export const stoppedHandlers: ExhaustiveVariantHandlers<TelegramState, 'stopped', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
  'telegram/submit': IGNORE,
  'telegram/retry': (state) => restart(state, false),
  'telegram/stop': (state) => restart(state, true),
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
  'record/saved': IGNORE,
  'record/failed': IGNORE,
};

export const stoppedWork = (): Work[] => [];
