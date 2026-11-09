// A linked device. It is watched for being unlinked from the phone.

import type { Context, Variant, VariantHandlers } from '../core';
import type { Work } from '../work';
import type { SignalEvent, SignalState } from './state';

type Linked = Variant<SignalState, 'linked'>;

export const linked: VariantHandlers<SignalState, 'linked', SignalEvent, Context> = {
  'signal/unlinked-from-phone': (state) => ({
    kind: 'off',
    deviceName: state.deviceName,
    unlinked: 'from-phone',
    error: null,
    attempts: 0,
  }),
  'signal/unlink': (state, event) => ({
    kind: 'unlinking',
    deviceName: state.deviceName,
    device: state.device,
    reason: event.reason,
    unlinks: state.unlinks + 1,
  }),
  'signal/forget': (state) => ({ kind: 'off', deviceName: state.deviceName, unlinked: null, error: null, attempts: 0 }),
  'signal/retry': (state) => ({ ...state, error: null }),
};

export const linkedWork = (state: Linked): Work[] => [
  { kind: 'signal-watch', key: `signal-watch:${state.device.deviceId}`, device: state.device },
];
