// What each kind of work does (work.ts), over the app's services. This is the only part of the machine with side
// effects. Work reports back only through `emit`; once `cancel` fires, what it still emits is dropped (runtime.ts),
// and work that holds something (TDLib, a preview loader) lets go of it.

import { withTimeLimit } from '../../core/time-limit';
import { StickerMigration } from '../../kinds/stickers/migration';
import { LinkingCancelledError } from '../../signal/link';
import type { AppServices, LinkedDevice, StoredDevice, TelegramSession } from '../services';
import type { AppEvent } from './events';
import { readRecord } from './record';
import type { Work } from './work';

/** What running work shares: the TDLib clients by instance, the Signal connections by device ID. */
export type Resources = {
  telegram: Map<string, TelegramSession>;
  devices: Map<number, LinkedDevice>;
};

export type WorkContext = {
  services: AppServices;
  resources: Resources;
  emit: (event: AppEvent) => void;
  cancel: AbortSignal;
  /** The device name the user entered, read when the phone has scanned the code. */
  deviceName: () => string;
};

/** How long deleting Telegram data may take; what is left is deleted at the next visit. */
const DELETE_TIME_LIMIT_MS = 5000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Resolves when `cancel` fires. */
const cancelled = (cancel: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (cancel.aborted) resolve();
    else cancel.addEventListener('abort', () => resolve(), { once: true });
  });

function sessionOf(resources: Resources, instance: string): TelegramSession {
  const session = resources.telegram.get(instance);
  if (!session) throw new Error('the Telegram connection was closed');
  return session;
}

/** The connection to a kept device: the one linking made, or a new one from what the browser keeps. */
function deviceOf({ services, resources }: WorkContext, stored: StoredDevice): LinkedDevice {
  let device = resources.devices.get(stored.deviceId);
  if (!device) {
    device = services.signal.restore(stored);
    resources.devices.set(stored.deviceId, device);
  }
  return device;
}

export async function runWork(work: Work, context: WorkContext): Promise<void> {
  const { services, resources, emit, cancel } = context;
  switch (work.kind) {
    case 'timer': {
      const timer = setTimeout(() => emit(work.event), work.seconds * 1000);
      cancel.addEventListener('abort', () => clearTimeout(timer), { once: true });
      return;
    }
    case 'lock':
      emit((await services.lock(work.wait)) ? { type: 'lock/held' } : { type: 'lock/elsewhere' });
      return;
    case 'load-record':
      try {
        emit({ type: 'record/loaded', record: readRecord(await services.snapshots.load()) });
      } catch (error) {
        emit({ type: 'record/load-failed', error: message(error) });
      }
      return;
    case 'delete-leftovers': {
      const deleteAll = async () => {
        for (const instance of await services.telegram.instances())
          if (instance !== work.keep) await services.telegram.deleteInstance(instance);
      };
      await withTimeLimit(deleteAll(), DELETE_TIME_LIMIT_MS, () => new Error('deleting took too long')).catch(
        () => undefined,
      );
      emit({ type: 'leftovers/deleted' });
      return;
    }
    case 'tdlib': {
      let app;
      try {
        app = await services.telegram.app();
      } catch (error) {
        emit({ type: 'telegram/start-failed', error: message(error) });
        return;
      }
      if (!app) {
        emit({
          type: 'telegram/start-failed',
          error:
            'The migration server has no Telegram app identity configured yet, so signing in to Telegram is not possible.',
        });
        return;
      }
      if (cancel.aborted) return;
      const session = services.telegram.start(
        app,
        work.instance,
        (auth) => emit({ type: 'telegram/auth', auth }),
        (error, restarted) => emit({ type: 'telegram/fatal', error, restarted }),
      );
      resources.telegram.set(work.instance, session);
      await cancelled(cancel);
      if (resources.telegram.get(work.instance) === session) resources.telegram.delete(work.instance);
      session.terminate();
      return;
    }
    case 'tdlib-request':
      try {
        await sessionOf(resources, work.instance).invoke(work.query);
        emit({ type: 'telegram/request-done' });
      } catch (error) {
        emit({ type: 'telegram/request-failed', error: message(error) });
      }
      return;
    case 'tdlib-checkpoint':
      try {
        await sessionOf(resources, work.instance).checkpoint();
        emit({ type: 'telegram/saved' });
      } catch (error) {
        emit({ type: 'telegram/save-failed', error: message(error) });
      }
      return;
    case 'tdlib-logout':
      try {
        await sessionOf(resources, work.instance).logOut();
        emit({ type: 'telegram/logged-out' });
      } catch (error) {
        emit({ type: 'telegram/logout-failed', error: message(error) });
      }
      return;
    case 'tdlib-delete':
      await withTimeLimit(services.telegram.deleteInstance(work.instance), DELETE_TIME_LIMIT_MS, () =>
        Error('deleting took too long'),
      ).catch(() => undefined);
      emit({ type: 'telegram/deleted' });
      return;
    case 'signal-link': {
      const linking = new AbortController();
      cancel.addEventListener('abort', () => linking.abort(), { once: true });
      let device: LinkedDevice;
      try {
        device = await services.signal.link(
          (url) => emit({ type: 'signal/qr', url }),
          context.deviceName,
          linking.signal,
        );
      } catch (error) {
        if (!(error instanceof LinkingCancelledError)) emit({ type: 'signal/link-failed', error: message(error) });
        return;
      }
      // Linked after the Signal step was left: the device is not wanted.
      if (cancel.aborted) {
        await device.unlink().catch(() => undefined);
        return;
      }
      resources.devices.set(device.deviceId, device);
      emit({ type: 'signal/linked', device: device.stored });
      return;
    }
    case 'signal-watch': {
      const device = deviceOf(context, work.device);
      device.onUnlinked = () => emit({ type: 'signal/unlinked-from-phone' });
      await cancelled(cancel);
      device.onUnlinked = () => undefined;
      return;
    }
    case 'signal-unlink':
      try {
        await deviceOf(context, work.device).unlink();
        resources.devices.delete(work.device.deviceId);
        emit({ type: 'signal/unlinked' });
      } catch (error) {
        emit({ type: 'signal/unlink-failed', error: message(error) });
      }
      return;
    case 'read-packs': {
      const migration = new StickerMigration(services.migration());
      try {
        await migration.readTelegram(sessionOf(resources, work.instance).source);
        for (const entry of migration.entries)
          if (work.deselected.includes(entry.pack.setId)) migration.setSelected(entry, false);
        await migration.lookUpInIndex();
        emit({ type: 'packs/read', migration });
      } catch (error) {
        emit({ type: 'packs/read-failed', error: message(error) });
      }
      return;
    }
    case 'load-previews': {
      cancel.addEventListener('abort', () => work.migration.stopPreviews(), { once: true });
      await work.migration.loadPreviews(sessionOf(resources, work.instance).source).catch(() => undefined);
      return;
    }
    case 'read-signal':
      try {
        await work.migration.readSignal(deviceOf(context, work.device));
        emit({ type: 'packs/signal-read', deviceId: work.device.deviceId });
      } catch (error) {
        emit({ type: 'packs/signal-failed', error: message(error) });
      }
      return;
    case 'run':
      try {
        await work.migration.run(deviceOf(context, work.device), sessionOf(resources, work.instance).source, cancel);
        emit({ type: 'run/ended' });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'run/failed', error: message(error) });
      }
      return;
  }
}
