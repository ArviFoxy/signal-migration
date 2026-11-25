// What each kind of work does (work.ts), over the app's services. This is the only part of the machine with side
// effects. Work reports back only through `emit`; once `cancel` fires, what it still emits is dropped (runtime.ts),
// and work that holds something (TDLib, SignalConnection, a preview loader) lets go of it.

import { errorMessage } from '../../core/errors';
import { withTimeLimit } from '../../core/time-limit';
import { addContacts, findFriends } from '../../kinds/friends/search';
import { copyToNoteToSelf } from '../../kinds/saved/copy';
import { StickerMigration } from '../../kinds/stickers/migration';
import { LinkingCancelledError } from '../../signal/link';
import type { TelegramFileRef } from '../../telegram/client';
import type { AppServices, LinkedDevice, StoredDevice, TelegramSession } from '../services';
import type { AppEvent } from './events';
import { readRecord } from './record';
import type { DeviceKey } from './signal/state';
import type { Work } from './work';

/** What running work shares: TDLib clients by instance, and Signal connections by unique DeviceKey. */
export type Resources = {
  telegram: Map<string, TelegramSession>;
  devices: Map<DeviceKey, LinkedDevice>;
  /** Handoff slot from `signal-link` to `signal-device` so a newly linked connection is adopted without re-opening. */
  linkedByStored: WeakMap<StoredDevice, LinkedDevice>;
};

export type WorkContext = {
  services: AppServices;
  resources: Resources;
  emit: (event: AppEvent) => void;
  cancel: AbortSignal;
  /** The device name the user entered, read when the phone has scanned the code. */
  deviceName: () => string;
};

/** How many Telegram pictures are read at the same time. */
const PHOTOS_AT_ONCE = 6;
/** While saved messages are copied, the state hears of the last one sent at most this often. */
const SAVED_PROGRESS_EVERY_MS = 500;
/** How long deleting Telegram data may take; what is left is deleted at the next visit. */
const DELETE_TIME_LIMIT_MS = 5000;

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

/** The connection to a kept device lifetime: the one linking made, or restored from what the browser keeps. */
function deviceOf({ services, resources }: WorkContext, key: DeviceKey, stored: StoredDevice): LinkedDevice {
  let device = resources.devices.get(key);
  if (!device) {
    const freshlyLinked = resources.linkedByStored.get(stored);
    if (freshlyLinked) {
      resources.linkedByStored.delete(stored);
      device = freshlyLinked;
    } else {
      device = services.signal.restore(stored);
    }
    resources.devices.set(key, device);
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
        emit({ type: 'record/load-failed', error: errorMessage(error) });
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
        if (!cancel.aborted) emit({ type: 'telegram/start-failed', error: errorMessage(error) });
        return;
      }
      if (!app) {
        if (!cancel.aborted) {
          emit({
            type: 'telegram/start-failed',
            error:
              'The migration server has no Telegram app identity configured yet, so signing in to Telegram is not possible.',
          });
        }
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
        if (!cancel.aborted) emit({ type: 'telegram/request-failed', error: errorMessage(error) });
      }
      return;
    case 'tdlib-checkpoint':
      try {
        await sessionOf(resources, work.instance).checkpoint();
        emit({ type: 'telegram/saved' });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'telegram/save-failed', error: errorMessage(error) });
      }
      return;
    case 'tdlib-logout':
      try {
        await sessionOf(resources, work.instance).logOut();
        emit({ type: 'telegram/logged-out' });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'telegram/logout-failed', error: errorMessage(error) });
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
        if (!cancel.aborted && !(error instanceof LinkingCancelledError))
          emit({ type: 'signal/link-failed', error: errorMessage(error) });
        return;
      }
      // Linked after the Signal step was left: the device is not wanted.
      if (cancel.aborted) {
        await device.unlink().catch(() => undefined);
        device.dispose();
        return;
      }
      resources.linkedByStored.set(device.stored, device);
      emit({ type: 'signal/linked', device: device.stored });
      return;
    }
    case 'signal-device': {
      const device = deviceOf(context, work.deviceKey, work.device);
      await cancelled(cancel);
      if (resources.devices.get(work.deviceKey) === device) resources.devices.delete(work.deviceKey);
      device.dispose();
      return;
    }
    case 'signal-watch': {
      const device = deviceOf(context, work.deviceKey, work.device);
      device.onUnlinked = () => emit({ type: 'signal/unlinked-from-phone' });
      await cancelled(cancel);
      device.onUnlinked = () => undefined;
      return;
    }
    case 'signal-unlink':
      try {
        await deviceOf(context, work.deviceKey, work.device).unlink();
        emit({ type: 'signal/unlinked' });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'signal/unlink-failed', error: errorMessage(error) });
      }
      return;
    case 'read-packs': {
      const migration = new StickerMigration(services.migration());
      const onChange = () => {
        if (!cancel.aborted && migration.readProgress) {
          emit({ type: 'packs/progress', done: migration.readProgress.done, total: migration.readProgress.total });
        }
      };
      migration.addEventListener('change', onChange);
      try {
        await migration.readTelegram(sessionOf(resources, work.instance).source, cancel);
        cancel.throwIfAborted();
        for (const entry of migration.entries)
          if (work.deselected.includes(entry.pack.setId)) migration.setSelected(entry, false);
        await migration.lookUpInIndex(cancel);
        cancel.throwIfAborted();
        emit({ type: 'packs/read', migration });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'packs/read-failed', error: errorMessage(error) });
      } finally {
        migration.removeEventListener('change', onChange);
      }
      return;
    }
    case 'load-previews': {
      await work.migration.loadPreviews(sessionOf(resources, work.instance).source, cancel).catch(() => undefined);
      return;
    }
    case 'read-signal':
      try {
        await work.migration.readSignal(deviceOf(context, work.deviceKey, work.device), cancel);
        if (!cancel.aborted) emit({ type: 'packs/signal-read', deviceKey: work.deviceKey });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'packs/signal-failed', error: errorMessage(error) });
      }
      return;
    case 'find-friends':
      try {
        const device = deviceOf(context, work.deviceKey, work.device);
        const search = await findFriends(
          sessionOf(resources, work.instance).people,
          device,
          services.friends.sources(device),
          (progress) => {
            if (!cancel.aborted) emit({ type: 'friends/progress', progress });
          },
          cancel,
        );
        if (!cancel.aborted) emit({ type: 'friends/found', search });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'friends/failed', error: errorMessage(error) });
      }
      return;
    case 'load-friend-photos': {
      const source = sessionOf(resources, work.instance).people;
      const { chats, contacts, found } = work.search;
      // In the order of the rows: each chat's own picture, and after a group's picture those of its members. Then
      // the contacts who are in no chat.
      const wanted = new Map<string, TelegramFileRef>();
      const want = (of: string, photo: TelegramFileRef | undefined) => {
        if (photo !== undefined && !wanted.has(of)) wanted.set(of, photo);
      };
      for (const chat of chats) {
        if (chat.kind === 'person') {
          want(`user:${chat.userId}`, found.get(chat.userId)?.person.photo);
        } else {
          want(`chat:${chat.chatId}`, chat.photo);
          for (const userId of chat.memberIds) want(`user:${userId}`, found.get(userId)?.person.photo);
        }
      }
      for (const userId of contacts) want(`user:${userId}`, found.get(userId)?.person.photo);
      const waiting = [...wanted];
      await Promise.all(
        Array.from({ length: PHOTOS_AT_ONCE }, async () => {
          for (let next = waiting.shift(); next && !cancel.aborted; next = waiting.shift()) {
            // A picture that cannot be read is left out; the row keeps its preview or its initials.
            const data = await source.readPhoto(next[1], cancel).catch(() => null);
            if (data && !cancel.aborted) emit({ type: 'friends/photo', of: next[0], data });
          }
        }),
      );
      return;
    }
    case 'add-friends':
      try {
        await addContacts(deviceOf(context, work.deviceKey, work.device), work.contacts, cancel);
        if (!cancel.aborted) emit({ type: 'run/friends-added', count: work.contacts.length });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'run/friends-failed', error: errorMessage(error) });
      }
      return;
    case 'read-saved':
      try {
        const messages = await sessionOf(resources, work.instance).saved.readMessages((read) => {
          if (!cancel.aborted) emit({ type: 'saved/progress', read });
        }, cancel);
        if (!cancel.aborted) emit({ type: 'saved/read', messages });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'saved/failed', error: errorMessage(error) });
      }
      return;
    case 'copy-saved': {
      // Every message sent is reported, but not every one at once: the browser keeps the last one reported, and
      // writes it each time. What a reload loses of the last half second is sent again, and Signal's apps drop it.
      let sent: number | null = null;
      let reported: number | null = null;
      let reportedAt = 0;
      const report = () => {
        if (sent === null || sent === reported) return;
        reported = sent;
        reportedAt = Date.now();
        emit({ type: 'run/saved-sent', upTo: sent });
      };
      try {
        await copyToNoteToSelf(
          deviceOf(context, work.deviceKey, work.device),
          work.messages,
          (id) => {
            sent = id;
            if (Date.now() - reportedAt >= SAVED_PROGRESS_EVERY_MS) report();
          },
          cancel,
          {
            source: sessionOf(resources, work.instance).saved,
            convert: context.services.migration().convert,
            onWait: (wait) => {
              if (wait) report();
              if (!cancel.aborted) emit({ type: 'run/saved-wait', wait });
            },
          },
        );
        report();
      } catch (error) {
        report();
        if (!cancel.aborted) emit({ type: 'run/saved-failed', error: errorMessage(error) });
      }
      return;
    }
    case 'run':
      try {
        await work.migration.run(
          deviceOf(context, work.deviceKey, work.device),
          sessionOf(resources, work.instance).source,
          cancel,
        );
        if (!cancel.aborted) emit({ type: 'run/ended' });
      } catch (error) {
        if (!cancel.aborted) emit({ type: 'run/failed', error: errorMessage(error) });
      }
      return;
  }
}
