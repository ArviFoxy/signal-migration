// The linked Signal device: its states and events.
//
//   off ─link─▶ linking (QR code shown) ─phone scans─▶ linked ─unlink─▶ unlinking ─▶ off
//    ▲             │                                     │
//    └──cancel─────┘                                     └──unlinked from the phone──▶ off
//
// The state holds the device as it is kept in the browser (StoredDevice), which is plain data; the runtime turns it
// into a connection where work needs one. The device is forgotten only once Signal has confirmed the unlink, or
// when the user chooses to forget it.

import type { StoredDevice } from '../../services';

/** Why the last device stopped being linked. `old-version`: it was linked by a version that could not message the
 * phone, and was unlinked to be linked again. */
export type UnlinkReason = 'by-user' | 'from-phone' | 'at-finish' | 'old-version';

/** What every state keeps: the name the device gets in Signal's list of linked devices. */
type Base = { deviceName: string };

export type SignalState =
  /** No device. `unlinked`: how the last one stopped being linked, during this visit. */
  | (Base & { kind: 'off'; unlinked: UnlinkReason | null; error: string | null; attempts: number })
  /** Waiting for the phone to scan the code; `qrUrl` is null until Signal has sent the address for it. */
  | (Base & { kind: 'linking'; attempt: number; qrUrl: string | null })
  | (Base & { kind: 'linked'; device: StoredDevice; error: string | null; unlinks: number })
  | (Base & { kind: 'unlinking'; device: StoredDevice; reason: UnlinkReason; unlinks: number });

export type SignalEvent =
  // From the parent machine.
  | { type: 'signal/link' }
  | { type: 'signal/cancel' }
  // From the user (and the end of the migration, for unlink).
  | { type: 'signal/unlink'; reason: UnlinkReason }
  | { type: 'signal/forget' }
  | { type: 'signal/retry' }
  | { type: 'signal/device-name'; name: string }
  // From Signal and the work around it.
  | { type: 'signal/qr'; url: string }
  | { type: 'signal/linked'; device: StoredDevice }
  | { type: 'signal/link-failed'; error: string }
  | { type: 'signal/unlinked-from-phone' }
  | { type: 'signal/unlinked' }
  | { type: 'signal/unlink-failed'; error: string }
  | { type: 'signal/unlink-deadline' };

/** The device the browser keeps, if any. */
export function keptDevice(state: SignalState): StoredDevice | null {
  return state.kind === 'linked' || state.kind === 'unlinking' ? state.device : null;
}
