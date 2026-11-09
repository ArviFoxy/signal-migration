// Waiting for the phone to scan the code. Leaving the Signal step cancels it; a device that linked anyway is
// unlinked again by the work (activities.ts).

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import type { SignalEvent, SignalState } from './state';

type Linking = Variant<SignalState, 'linking'>;

const off = (state: Linking, error: string | null): SignalState => ({
  kind: 'off',
  deviceName: state.deviceName,
  unlinked: null,
  error,
  attempts: state.attempt,
});

export const linking: VariantHandlers<SignalState, 'linking', SignalEvent, Context> = {
  'signal/qr': (state, event) => ({ ...state, qrUrl: event.url }),
  'signal/linked': (state, event) => ({
    kind: 'linked',
    deviceName: state.deviceName,
    device: event.device,
    error: null,
    unlinks: 0,
  }),
  'signal/link-failed': (state, event) => off(state, event.error),
  'signal/cancel': (state) => off(state, null),
  'signal/device-name': (state, event) => ({ ...state, deviceName: event.name }),
};

export const linkingWork = (state: Linking): Work[] => [{ kind: 'signal-link', key: `signal-link:${state.attempt}` }];
