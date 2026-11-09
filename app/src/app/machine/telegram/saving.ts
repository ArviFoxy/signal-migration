// Signed in; the login is being saved in the browser (TelegramClient.checkpoint) before the login counts as done.

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import { afterReport, deleting } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type Saving = Variant<TelegramState, 'saving'>;

const signedIn = (state: Saving, error: string | null): TelegramState => ({
  kind: 'signed-in',
  method: state.method,
  instance: state.instance,
  attempt: state.attempt,
  error,
});

export const saving: VariantHandlers<TelegramState, 'saving', TelegramEvent, Context> = {
  'telegram/saved': (state) => signedIn(state, null),
  'telegram/save-failed': (state, event) =>
    signedIn(
      state,
      `This browser could not save the Telegram login, so a reload will ask to sign in again: ${event.error}`,
    ),
  'telegram/auth': (state, { auth }) => (auth._ === 'authorizationStateReady' ? state : afterReport(state, auth)),
  'telegram/stop': (state) => ({
    kind: 'signing-out',
    method: state.method,
    instance: state.instance,
    attempt: state.attempt,
  }),
  'telegram/forget': (state) => deleting(state),
};

export const savingWork = (state: Saving): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
  {
    kind: 'tdlib-checkpoint',
    key: `tdlib-checkpoint:${state.instance}:${state.attempt}`,
    instance: state.instance,
  },
];
