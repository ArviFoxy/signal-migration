// No device. The parent starts linking when the Signal step shows.

import { type Context, type ExhaustiveVariantHandlers, IGNORE } from '../core';
import type { SignalEvent, SignalState } from './state';

export const off: ExhaustiveVariantHandlers<SignalState, 'off', SignalEvent, Context> = {
  'signal/link': (state) => ({
    kind: 'linking',
    deviceName: state.deviceName,
    attempt: state.attempts + 1,
    qrUrl: null,
  }),
  'signal/cancel': IGNORE,
  'signal/unlink': IGNORE,
  'signal/forget': IGNORE,
  'signal/retry': (state) => ({ ...state, error: null }),
  'signal/device-name': (state, event) => ({ ...state, deviceName: event.name }),
  'signal/qr': IGNORE,
  'signal/linked': IGNORE,
  'signal/link-failed': IGNORE,
  'signal/unlinked-from-phone': IGNORE,
  'signal/unlinked': IGNORE,
  'signal/unlink-failed': IGNORE,
  'signal/unlink-deadline': IGNORE,
};
