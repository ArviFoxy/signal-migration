// The linked Signal device, as a state machine.
//
//   off ──link──▶ linking (QR code shown) ──phone scans──▶ linked ──unlink──▶ unlinking ──▶ off
//    ▲               │                                       │
//    └──cancel───────┘                                       └──unlinked from the phone──▶ off
//
// Waiting for the scan can take minutes, so linking runs outside the queue and can be cancelled; an attempt that was
// cancelled is ignored when it ends, and a device it linked anyway is unlinked again. Everything else runs one at a
// time, from one queue. The device's login is kept by the workflow (`keep`) as soon as it is linked, and forgotten
// only once Signal has confirmed the unlink.

import { DEFAULT_DEVICE_NAME, LinkingCancelledError } from '../signal/link';
import type { LinkedDevice, SignalServices, StoredDevice } from './services';

export type UnlinkReason = 'by-user' | 'from-phone' | 'at-finish';

export type SignalState =
  /** No device. `unlinked`: how the last one stopped being linked, during this visit. */
  | { kind: 'off'; unlinked: UnlinkReason | null }
  /** Waiting for the phone to scan the code; `qrUrl` is null until Signal has sent the address for it. */
  | { kind: 'linking'; qrUrl: string | null }
  | { kind: 'linked'; device: LinkedDevice }
  | { kind: 'unlinking'; device: LinkedDevice };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class SignalLink extends EventTarget {
  state: SignalState = { kind: 'off', unlinked: null };
  /** Why the last link or unlink failed, until the next attempt. */
  error: string | null = null;
  /** The name the device gets in Signal's list of linked devices; read when the phone has scanned the code. */
  deviceName = DEFAULT_DEVICE_NAME;
  #attempt: AbortController | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly services: SignalServices,
    /** Keeps the device's login in the browser, or nothing when null; resolves once written. */
    private readonly keep: (device: StoredDevice | null) => Promise<void>,
  ) {
    super();
  }

  get device(): LinkedDevice | null {
    return this.state.kind === 'linked' || this.state.kind === 'unlinking' ? this.state.device : null;
  }

  #set(state: SignalState): void {
    this.state = state;
    this.dispatchEvent(new Event('change'));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = async () => {
      try {
        await operation();
      } catch (error) {
        this.error = message(error);
        this.dispatchEvent(new Event('change'));
      }
    };
    this.#queue = this.#queue.then(run);
    return this.#queue;
  }

  async #attach(device: LinkedDevice): Promise<void> {
    device.onUnlinked = () => void this.#enqueue(() => this.#lost(device));
    this.#set({ kind: 'linked', device });
    await this.keep(device.stored);
  }

  /** The device was unlinked from the phone (or by Signal). */
  async #lost(device: LinkedDevice): Promise<void> {
    if (this.device !== device) return;
    await this.keep(null);
    this.#set({ kind: 'off', unlinked: 'from-phone' });
  }

  /**
   * Uses the device an earlier visit linked. If it was unlinked meanwhile, its first use reports that. A device
   * linked by an earlier version of the app, without the keys to message the other devices, is unlinked, and the
   * Signal step asks to link again.
   */
  restore(stored: StoredDevice): void {
    if (this.state.kind !== 'off') return;
    const device = this.services.restore(stored);
    device.onUnlinked = () => void this.#enqueue(() => this.#lost(device));
    this.#set({ kind: 'linked', device });
    if (!stored.identityPrivate) {
      void this.unlink('by-user').then(() => {
        this.error =
          'Link Signal again. The device linked earlier could not tell your phone about new sticker packs, so it was unlinked.';
        this.dispatchEvent(new Event('change'));
      });
    }
  }

  /** Shows a code to scan and links the device when the phone scans it. Does nothing unless off. */
  link(): void {
    if (this.state.kind !== 'off') return;
    const attempt = new AbortController();
    this.#attempt = attempt;
    this.error = null;
    this.#set({ kind: 'linking', qrUrl: null });
    void (async () => {
      let device: LinkedDevice;
      try {
        device = await this.services.link(
          (qrUrl) => this.#attempt === attempt && this.#set({ kind: 'linking', qrUrl }),
          () => this.deviceName,
          attempt.signal,
        );
      } catch (error) {
        if (this.#attempt !== attempt || error instanceof LinkingCancelledError) return;
        this.#attempt = null;
        this.error = message(error);
        this.#set({ kind: 'off', unlinked: null });
        return;
      }
      if (this.#attempt !== attempt) {
        // Cancelled while the phone was already linking: the device is not wanted.
        await device.unlink().catch(() => undefined);
        return;
      }
      this.#attempt = null;
      await this.#enqueue(() => this.#attach(device));
    })();
  }

  /** Stops waiting for a scan. */
  cancel(): void {
    if (this.state.kind !== 'linking') return;
    this.#attempt?.abort();
    this.#attempt = null;
    this.#set({ kind: 'off', unlinked: null });
  }

  /** Clears a failed attempt, so that a new code can be shown. */
  retry(): void {
    this.error = null;
    this.dispatchEvent(new Event('change'));
  }

  /** Unlinks the device. If Signal does not confirm, the device stays linked and the error is kept. */
  unlink(reason: UnlinkReason): Promise<void> {
    this.cancel();
    return this.#enqueue(async () => {
      const device = this.device;
      if (!device) return;
      this.error = null;
      this.#set({ kind: 'unlinking', device });
      try {
        await device.unlink();
      } catch (error) {
        this.#set({ kind: 'linked', device });
        throw error;
      }
      await this.keep(null);
      this.#set({ kind: 'off', unlinked: reason });
    });
  }

  settled(): Promise<void> {
    return this.#queue;
  }
}
