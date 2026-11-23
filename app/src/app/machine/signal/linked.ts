// A linked device. Owned by `signal-device` work (which disposes the connection on exit) and watched for phone unlink.

import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import type { SignalEvent, SignalState } from './state';

type Linked = Variant<SignalState, 'linked'>;

export const linked: ExhaustiveVariantHandlers<SignalState, 'linked', SignalEvent, Context> = {
  'signal/link': IGNORE,
  'signal/cancel': IGNORE,
  'signal/unlink': (state, event) => ({
    kind: 'unlinking',
    deviceName: state.deviceName,
    deviceKey: state.deviceKey,
    device: state.device,
    reason: event.reason,
    unlinks: state.unlinks + 1,
  }),
  'signal/forget': (state) => ({ kind: 'off', deviceName: state.deviceName, unlinked: null, error: null, attempts: 0 }),
  'signal/retry': (state) => ({ ...state, error: null }),
  'signal/device-name': IGNORE,
  'signal/qr': IGNORE,
  'signal/linked': IGNORE,
  'signal/link-failed': IGNORE,
  'signal/unlinked-from-phone': (state) => ({
    kind: 'off',
    deviceName: state.deviceName,
    unlinked: 'from-phone',
    error: null,
    attempts: 0,
  }),
  'signal/unlinked': IGNORE,
  'signal/unlink-failed': IGNORE,
  'signal/unlink-deadline': IGNORE,
};

export const linkedWork = (state: Linked): Work[] => [
  { kind: 'signal-device', key: `signal-device:${state.deviceKey}`, deviceKey: state.deviceKey, device: state.device },
  { kind: 'signal-watch', key: `signal-watch:${state.deviceKey}`, deviceKey: state.deviceKey, device: state.device },
];
