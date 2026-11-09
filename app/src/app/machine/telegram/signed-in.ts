// Signed in, and the login is saved in the browser.

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import { afterReport, deleting } from './moves';
import type { TelegramEvent, TelegramState } from './state';

type SignedIn = Variant<TelegramState, 'signed-in'>;

export const signedIn: VariantHandlers<TelegramState, 'signed-in', TelegramEvent, Context> = {
  'telegram/auth': (state, { auth }) => (auth._ === 'authorizationStateReady' ? state : afterReport(state, auth)),
  'telegram/stop': (state) => ({
    kind: 'signing-out',
    method: state.method,
    instance: state.instance,
    attempt: state.attempt,
  }),
  'telegram/forget': (state) => deleting(state),
};

export const signedInWork = (state: SignedIn): Work[] => [
  { kind: 'tdlib', key: `tdlib:${state.instance}:${state.attempt}`, instance: state.instance },
];
