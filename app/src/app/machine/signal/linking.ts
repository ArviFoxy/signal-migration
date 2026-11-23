// Waiting for the phone to scan the code. Leaving the Signal step cancels it; a device that linked anyway is
// unlinked again by the work (activities.ts).

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import { deviceKeyOf, type SignalEvent, type SignalState } from './state';

type Linking = Variant<SignalState, 'linking'>;

const off = (state: Linking, error: string | null): SignalState => ({
  kind: 'off',
  deviceName: state.deviceName,
  unlinked: null,
  error,
  attempts: state.attempt,
});

export const linking: ExhaustiveVariantHandlers<SignalState, 'linking', SignalEvent, Context> = {
  'signal/link': IGNORE,
  'signal/cancel': (state) => off(state, null),
  'signal/unlink': IGNORE,
  'signal/forget': IGNORE,
  'signal/retry': IGNORE,
  'signal/device-name': (state, event) => ({ ...state, deviceName: event.name }),
  'signal/qr': (state, event) => ({ ...state, qrUrl: event.url }),
  'signal/linked': (state, event, context) => ({
    kind: 'linked',
    deviceName: state.deviceName,
    deviceKey: deviceKeyOf(event.device, context.nonce),
    device: event.device,
    error: null,
    unlinks: 0,
  }),
  'signal/link-failed': (state, event) => off(state, event.error),
  'signal/unlinked-from-phone': IGNORE,
  'signal/unlinked': IGNORE,
  'signal/unlink-failed': IGNORE,
  'signal/unlink-deadline': IGNORE,
};

export const linkingWork = (state: Linking): Work[] => [{ kind: 'signal-link', key: `signal-link:${state.attempt}` }];
