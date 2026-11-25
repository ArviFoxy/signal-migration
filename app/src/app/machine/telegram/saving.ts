// Signed in; the login is being saved in the browser (TelegramClient.checkpoint) before the login counts as done.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { afterReport, deleting, stopped } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type Saving = Variant<TelegramState, 'saving'>;

const signedIn = (state: Saving, error: string | null): TelegramState => ({
  kind: 'signed-in',
  method: state.method,
  instance: state.instance,
  attempt: state.attempt,
  error,
});

export const saving: ExhaustiveVariantHandlers<TelegramState, 'saving', TelegramEvent, Context> = {
  'telegram/start': IGNORE,
  'telegram/use-method': IGNORE,
  'telegram/submit': IGNORE,
  'telegram/retry': IGNORE,
  'telegram/stop': (state) => ({
    kind: 'signing-out',
    method: state.method,
    instance: state.instance,
    attempt: state.attempt,
  }),
  'telegram/forget': (state) => deleting(state),
  'telegram/auth': (state, { auth }) => (auth._ === 'authorizationStateReady' ? state : afterReport(state, auth)),
  'telegram/fatal': (state, event) => (event.restarted ? state : stopped(state, event.error)),
  'telegram/start-failed': IGNORE,
  'telegram/start-deadline': IGNORE,
  'telegram/request-done': IGNORE,
  'telegram/request-failed': IGNORE,
  'telegram/saved': (state) => signedIn(state, null),
  'telegram/save-failed': (state, event) =>
    signedIn(
      state,
      `This browser could not save the Telegram login, so closing or reloading this tab will ask to sign in again: ${event.error}`,
    ),
  'telegram/logged-out': IGNORE,
  'telegram/logout-failed': IGNORE,
  'telegram/logout-deadline': IGNORE,
  'telegram/ending-deadline': IGNORE,
  'telegram/deleted': IGNORE,
  'record/saved': IGNORE,
  'record/failed': IGNORE,
};

export const savingWork = (state: Saving): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
  {
    kind: 'tdlib-checkpoint',
    key: `tdlib-checkpoint:${state.instance}:${state.attempt}`,
    instance: state.instance,
  },
];
