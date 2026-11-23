// Unlinking the device. It is forgotten once Signal confirms; if Signal does not, or gives no answer within the
// request time limit, it stays linked, with the error. `signal-device` keeps the connection alive until `off`.

import { noAnswer, REQUEST_TIME_LIMIT_S } from '../../../core/time-limit';
import { type Context, type ExhaustiveVariantHandlers, IGNORE, type Variant } from '../core';
import type { Work } from '../work';
import type { SignalEvent, SignalState } from './state';

type Unlinking = Variant<SignalState, 'unlinking'>;

const failed = (state: Unlinking, error: string): SignalState => ({
  kind: 'linked',
  deviceName: state.deviceName,
  deviceKey: state.deviceKey,
  device: state.device,
  error: `Unlinking Signal failed: ${error}`,
  unlinks: state.unlinks,
});

/** Shown after unlinking a device that an earlier version linked, so that the user links again. */
const LINK_AGAIN =
  'Link Signal again. The device linked earlier could not tell your phone about new sticker packs, so it was unlinked.';

export const unlinking: ExhaustiveVariantHandlers<SignalState, 'unlinking', SignalEvent, Context> = {
  'signal/link': IGNORE,
  'signal/cancel': IGNORE,
  'signal/unlink': IGNORE,
  'signal/forget': (state) => ({ kind: 'off', deviceName: state.deviceName, unlinked: null, error: null, attempts: 0 }),
  'signal/retry': IGNORE,
  'signal/device-name': IGNORE,
  'signal/qr': IGNORE,
  'signal/linked': IGNORE,
  'signal/link-failed': IGNORE,
  'signal/unlinked': (state) => ({
    kind: 'off',
    deviceName: state.deviceName,
    unlinked: state.reason === 'old-version' ? null : state.reason,
    error: state.reason === 'old-version' ? LINK_AGAIN : null,
    attempts: 0,
  }),
  // The phone was faster.
  'signal/unlinked-from-phone': (state) => ({
    kind: 'off',
    deviceName: state.deviceName,
    unlinked: state.reason === 'old-version' ? null : state.reason,
    error: state.reason === 'old-version' ? LINK_AGAIN : null,
    attempts: 0,
  }),
  'signal/unlink-failed': (state, event) => failed(state, event.error),
  'signal/unlink-deadline': (state) => failed(state, noAnswer('Signal', REQUEST_TIME_LIMIT_S)),
};

export const unlinkingWork = (state: Unlinking): Work[] => [
  { kind: 'signal-device', key: `signal-device:${state.deviceKey}`, deviceKey: state.deviceKey, device: state.device },
  {
    kind: 'signal-unlink',
    key: `signal-unlink:${state.deviceKey}:${state.unlinks}`,
    deviceKey: state.deviceKey,
    device: state.device,
  },
  {
    kind: 'timer',
    key: `signal-unlink-deadline:${state.deviceKey}:${state.unlinks}`,
    seconds: REQUEST_TIME_LIMIT_S,
    event: { type: 'signal/unlink-deadline' },
  },
];
