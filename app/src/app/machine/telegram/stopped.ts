// TDLib does not run on the kept instance: it did not start, or it closed by itself. The instance may still hold a
// login, so it stays kept: "Try again" starts TDLib on it again, and a sign-out starts it to end the session.

import type { Context, Variant, VariantHandlers } from '../core';
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

export const stoppedHandlers: VariantHandlers<TelegramState, 'stopped', TelegramEvent, Context> = {
  'telegram/retry': (state) => restart(state, false),
  'telegram/stop': (state) => restart(state, true),
  'telegram/forget': (state) => deleting(state),
  'telegram/use-method': (state, event) => ({ ...state, method: event.method }),
};

export const stoppedWork = (): Work[] => [];
