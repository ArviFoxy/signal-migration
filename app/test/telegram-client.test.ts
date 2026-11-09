// The Telegram client (telegram/client.ts) and the sticker source over it (kinds/stickers/telegram-packs.ts) when
// TDLib stops after an internal error. tdweb is replaced by a simulated TDLib, which numbers files differently in
// each run, as TDLib does, so that a file number kept from an earlier run names another file.

import { afterEach, expect, it, vi } from 'vitest';
import { telegramSource } from '../src/kinds/stickers/telegram-packs';
import { type LoginCopies, TelegramClient, TelegramRestartedError } from '../src/telegram/client';

type Query = { '@type': string; [field: string]: unknown };
type Update = { '@type': string; [field: string]: unknown };

/** The account's one sticker pack: each sticker's permanent identifier and its file's bytes. */
const PACK = { id: '100', title: 'Foxes', stickers: ['u1', 'u2', 'u3'] };
const bytesOf = (uniqueId: string) => new TextEncoder().encode(`file ${uniqueId}`);

const simulated = vi.hoisted(() => {
  /** One run of the simulated TDLib, created by tdweb's client constructor. */
  class SimulatedTdlib {
    static runs: SimulatedTdlib[] = [];
    /** What the browser keeps: whether TDLib's database holds a login. */
    static loginInDatabase = false;
    /** Called with each run as it is created, before it reports anything. */
    static onCreate: (run: SimulatedTdlib) => void = () => undefined;

    readonly number = SimulatedTdlib.runs.length + 1;
    readonly sent: string[] = [];
    holdDownloads = false;
    crashed = false;
    readonly worker = { terminate: () => undefined };
    readonly #onUpdate: (update: Update) => void;

    constructor(options: { onUpdate: (update: Update) => void }) {
      this.#onUpdate = options.onUpdate;
      SimulatedTdlib.runs.push(this);
      SimulatedTdlib.onCreate(this);
      this.#report('authorizationStateWaitTdlibParameters');
    }

    #report(state: string): void {
      setTimeout(() => {
        if (!this.crashed)
          this.#onUpdate({ '@type': 'updateAuthorizationState', authorization_state: { '@type': state } });
      }, 0);
    }

    /** TDLib's number for a sticker's file in this run: run 1 counts up, later runs count down. */
    fileIdOf(uniqueId: string): number {
      const index = PACK.stickers.indexOf(uniqueId);
      return this.number === 1 ? 10 + index : 10 + PACK.stickers.length - 1 - index;
    }

    uniqueIdOf(fileId: number): string {
      return PACK.stickers.find((uniqueId) => this.fileIdOf(uniqueId) === fileId)!;
    }

    /** TDLib stops: tdweb sends updateFatalError and answers nothing more. */
    crash(): void {
      this.crashed = true;
      this.#onUpdate({ '@type': 'updateFatalError', error: new Error('Aborted()') });
    }

    send(query: Query): Promise<unknown> {
      this.sent.push(query['@type']);
      if (this.crashed) return new Promise(() => undefined);
      const file = (fileId: number) => ({
        '@type': 'file',
        id: fileId,
        size: 4,
        expected_size: 4,
        local: { downloaded_size: 0 },
        remote: { unique_id: this.uniqueIdOf(fileId) },
      });
      switch (query['@type']) {
        case 'setTdlibParameters':
          this.#report(
            SimulatedTdlib.loginInDatabase ? 'authorizationStateReady' : 'authorizationStateWaitPhoneNumber',
          );
          return Promise.resolve({ '@type': 'ok' });
        case 'syncDatabase':
          return Promise.resolve({ '@type': 'ok' });
        case 'getInstalledStickerSets':
          return Promise.resolve({ '@type': 'stickerSets', sets: [{ '@type': 'stickerSetInfo', id: PACK.id }] });
        case 'getStickerSet':
          return Promise.resolve({
            '@type': 'stickerSet',
            id: PACK.id,
            title: PACK.title,
            stickers: PACK.stickers.map((uniqueId) => ({
              '@type': 'sticker',
              sticker: file(this.fileIdOf(uniqueId)),
              emoji: '🦊',
              format: { '@type': 'stickerFormatWebp' },
              thumbnail: null,
            })),
          });
        case 'downloadFile':
          return this.holdDownloads ? new Promise(() => undefined) : Promise.resolve(file(query.file_id as number));
        case 'getFile':
          return Promise.resolve(file(query.file_id as number));
        case 'readFile':
          return Promise.resolve({
            '@type': 'filePart',
            data: new Blob([bytesOf(this.uniqueIdOf(query.file_id as number))]),
          });
        case 'deleteFile':
        case 'cancelDownloadFile':
        case 'requestQrCodeAuthentication':
          return query['@type'] === 'requestQrCodeAuthentication'
            ? new Promise(() => undefined)
            : Promise.resolve({ '@type': 'ok' });
        default:
          return Promise.reject({ '@type': 'error', code: 400, message: `not simulated: ${query['@type']}` });
      }
    }
  }
  return { SimulatedTdlib };
});

vi.mock('tdweb', () => ({ default: { default: simulated.SimulatedTdlib } }));

const { SimulatedTdlib } = simulated;

/** Our copies of logins, in memory; `events` records each restore and each TDLib run in order. */
function loginCopies(events: string[]): LoginCopies & { saved: Set<string> } {
  const saved = new Set<string>();
  return {
    saved,
    save: async (instance) => void saved.add(instance),
    restore: async (instance) => {
      events.push('restore');
      return saved.has(instance);
    },
  };
}

/** A client signed in, with its login copied; returns it with the login states it passed on. */
async function signedInClient(events: string[] = []) {
  SimulatedTdlib.loginInDatabase = true;
  SimulatedTdlib.onCreate = (run) => events.push(`run ${run.number}`);
  const states: string[] = [];
  const fatalErrors: [string, boolean][] = [];
  const copies = loginCopies(events);
  const client = new TelegramClient(
    'telegram-0000000000000001',
    { apiId: 1, apiHash: 'simulated' },
    (state) => states.push(state._),
    (error, restarted) => fatalErrors.push([error, restarted]),
    copies,
  );
  await vi.waitFor(() => expect(states).toContain('authorizationStateReady'));
  await client.checkpoint();
  return { client, states, fatalErrors, copies };
}

const currentRun = () => SimulatedTdlib.runs.at(-1)!;

afterEach(() => {
  SimulatedTdlib.runs.length = 0;
  vi.useRealTimers();
});

// Detects: a download that TDLib's stop cut off never completing (the migration stuck on "Downloading"), and a file
// number kept from before the restart reading another sticker's file.
it('completes a download cut off by a restart, with the bytes of the same sticker', async () => {
  const { client } = await signedInClient();
  const source = telegramSource(client);
  const [pack] = await source.readPacks(() => undefined);
  currentRun().holdDownloads = true;
  const reading = source.readFile(pack.stickers[0].fileId);
  await vi.waitFor(() => expect(currentRun().sent).toContain('downloadFile'));
  currentRun().crash();
  expect(await reading).toEqual(bytesOf('u1'));
  expect(SimulatedTdlib.runs.length).toBe(2);
});

// Detects: a restart that starts TDLib before our copy of the login is back in its database, so that the login
// depends on what TDLib wrote before it stopped.
it('writes our copy of the login back before TDLib starts again', async () => {
  const events: string[] = [];
  const { client } = await signedInClient(events);
  events.length = 0;
  currentRun().crash();
  await client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } });
  expect(events).toEqual(['restore', 'run 2']);
});

// Detects: a restart that those listening see as the login going away and coming back, which ends the migration
// and asks the user to sign in again.
it('passes on no change of the login state when TDLib restarts', async () => {
  const { client, states, fatalErrors } = await signedInClient();
  const before = [...states];
  currentRun().crash();
  await client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } });
  expect(states).toEqual(before);
  expect(fatalErrors).toEqual([['Aborted()', true]]);
});

// Detects: requests waiting forever on a TDLib that stopped before a login was saved (a clear that never ends); a
// restart of a login that cannot be continued; and requests failing as if they could be sent again, which the
// sticker source then sends again forever.
it('stops a client whose TDLib stopped before a login was saved', async () => {
  SimulatedTdlib.loginInDatabase = false;
  const states: string[] = [];
  const fatalErrors: [string, boolean][] = [];
  const client = new TelegramClient(
    'telegram-0000000000000002',
    { apiId: 1, apiHash: 'simulated' },
    (state) => states.push(state._),
    (error, restarted) => fatalErrors.push([error, restarted]),
    loginCopies([]),
  );
  await vi.waitFor(() => expect(states).toContain('authorizationStateWaitPhoneNumber'));
  const request = client.invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
  await vi.waitFor(() => expect(currentRun().sent).toContain('requestQrCodeAuthentication'));
  currentRun().crash();
  await expect(request).rejects.toThrow('the Telegram connection was closed');
  await expect(request).rejects.not.toBeInstanceOf(TelegramRestartedError);
  const later = client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } });
  await expect(later).rejects.not.toBeInstanceOf(TelegramRestartedError);
  expect(fatalErrors).toEqual([['Aborted()', false]]);
  expect(SimulatedTdlib.runs.length).toBe(1);
});

// Detects: TDLib restarted again and again without a pause when it stops at every start.
it('waits longer before each restart that follows a failed one', async () => {
  const { client } = await signedInClient();
  vi.useFakeTimers();
  SimulatedTdlib.onCreate = (run) => {
    if (run.number > 1) setTimeout(() => run.crash(), 0);
  };
  currentRun().crash();
  void client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } }).catch(() => null);
  await vi.advanceTimersByTimeAsync(10);
  expect(SimulatedTdlib.runs.length).toBe(2);
  await vi.advanceTimersByTimeAsync(900);
  expect(SimulatedTdlib.runs.length).toBe(2);
  await vi.advanceTimersByTimeAsync(200);
  expect(SimulatedTdlib.runs.length).toBe(3);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(SimulatedTdlib.runs.length).toBe(3);
  await vi.advanceTimersByTimeAsync(1_100);
  expect(SimulatedTdlib.runs.length).toBe(4);
});
