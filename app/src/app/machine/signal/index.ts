// The Signal device machine: the variants' handlers and work put together.

import { byVariant, type Context } from '../core';
import type { Work } from '../work';
import { linked, linkedWork } from './linked';
import { linking, linkingWork } from './linking';
import { off } from './off';
import type { SignalEvent, SignalState } from './state';
import { unlinking, unlinkingWork } from './unlinking';

export * from './state';

export const signalTransition: (state: SignalState, event: SignalEvent, context: Context) => SignalState = byVariant<
  SignalState,
  SignalEvent,
  Context
>({ off, linking, linked, unlinking });

export function signalWork(state: SignalState): Work[] {
  switch (state.kind) {
    case 'off':
      return [];
    case 'linking':
      return linkingWork(state);
    case 'linked':
      return linkedWork(state);
    case 'unlinking':
      return unlinkingWork(state);
  }
}

export const initialSignal = (deviceName: string): SignalState => ({
  kind: 'off',
  deviceName,
  unlinked: null,
  error: null,
  attempts: 0,
});
