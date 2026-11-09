// No device. The parent starts linking when the Signal step shows.

import type { Context, VariantHandlers } from '../core';
import type { SignalEvent, SignalState } from './state';

export const off: VariantHandlers<SignalState, 'off', SignalEvent, Context> = {
  'signal/link': (state) => ({
    kind: 'linking',
    deviceName: state.deviceName,
    attempt: state.attempts + 1,
    qrUrl: null,
  }),
  'signal/retry': (state) => ({ ...state, error: null }),
  'signal/device-name': (state, event) => ({ ...state, deviceName: event.name }),
};
