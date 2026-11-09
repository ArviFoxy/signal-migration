// Reading the record, then deleting Telegram data that no login holds (ended logins, older versions), then
// continuing from the record: the same phase, the same logins. A record that cannot be read is not taken for none:
// the user is told and can try again, so that nothing kept is forgotten.

import { DEFAULT_DEVICE_NAME } from '../../../signal/device-name';
import type { Context, Variant, VariantHandlers } from '../core';
import type { AppEvent } from '../events';
import type { Record } from '../record';
import { initialSignal, type SignalState } from '../signal';
import { initialTelegram, type TelegramState } from '../telegram';
import type { Work } from '../work';
import { beginEnding } from './session';
import type { AppState, Session } from './state';

type Loading = Variant<AppState, 'loading'>;

export function fromRecord(record: Record | null, context: Context): AppState {
  const telegram: TelegramState = record?.telegram
    ? { kind: 'starting', method: 'qr', instance: record.telegram, attempt: 1, resumed: true, stop: false }
    : initialTelegram;
  const signal: SignalState = record?.signal
    ? { kind: 'linked', deviceName: DEFAULT_DEVICE_NAME, device: record.signal, error: null, unlinks: 0 }
    : initialSignal(DEFAULT_DEVICE_NAME);
  const session: Session = {
    telegram,
    signal,
    packs: { kind: 'none' },
    deselected: record?.deselected ?? [],
    notice: null,
  };
  if (!record) return { ...session, kind: 'setup', step: 'start' };
  switch (record.phase) {
    case 'setup':
      return { ...session, kind: 'setup', step: record.step };
    case 'migrating':
      return { ...session, kind: 'migrating', run: { attempt: 1, status: 'running', error: null } };
    case 'ending':
      return beginEnding({ ...session, kind: 'setup', step: 'start' }, record.why ?? 'clear', context);
  }
}

export const loading: VariantHandlers<AppState, 'loading', AppEvent, Context> = {
  'record/loaded': (state, event) => (state.record === undefined ? { ...state, record: event.record } : state),
  'record/load-failed': (state, event) => ({
    kind: 'load-failed',
    error: `Your browser could not read the saved migration: ${event.error}`,
    attempt: state.attempt,
  }),
  'leftovers/deleted': (state, _, context) => (state.record === undefined ? state : fromRecord(state.record, context)),
};

export const loadingWork = (state: Loading): Work[] =>
  state.record === undefined
    ? [{ kind: 'load-record', key: `load-record:${state.attempt}` }]
    : [{ kind: 'delete-leftovers', key: 'leftovers', keep: state.record?.telegram ?? null }];
