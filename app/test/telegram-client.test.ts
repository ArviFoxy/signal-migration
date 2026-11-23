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
    readonly queries: Query[] = [];
    holdDownloads = false;
    crashed = false;
    readonly worker = { terminate: () => undefined };
    readonly channel = {
      onmessage: (() => undefined) as ((msg: unknown) => void) | null,
      closed: false,
      close: async () => {
        await Promise.resolve();
        this.channel.closed = true;
      },
    };
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
      this.queries.push(query);
      if (this.crashed) return new Promise(() => undefined);
      const file = (fileId: number) => {
        const uniqueId = this.uniqueIdOf(fileId);
        const size = bytesOf(uniqueId).length;
        return {
          '@type': 'file',
          id: fileId,
          size,
          expected_size: size,
          local: { downloaded_size: 0 },
          remote: { id: uniqueId, unique_id: uniqueId },
        };
      };
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
        case 'getRemoteFile':
          return Promise.resolve(file(this.fileIdOf(String(query.remote_file_id))));
        case 'readFile':
          return Promise.resolve({
            '@type': 'filePart',
            data: new Blob([bytesOf(this.uniqueIdOf(query.file_id as number))]),
          });
        case 'readFilePart': {
          const all = bytesOf(this.uniqueIdOf(query.file_id as number));
          const offset = Number(query.offset ?? 0);
          const count = Number(query.count ?? all.length);
          return Promise.resolve({
            '@type': 'filePart',
            data: new Blob([all.subarray(offset, offset + count)]),
          });
        }
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

// Detects: a TDLib request that is never answered (reading packs, signing out) keeping the app waiting forever.
it('fails a Telegram request that gets no answer within 60 seconds', async () => {
  const { client } = await signedInClient();
  vi.useFakeTimers();
  const request = client.invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
  let failure: string | null = null;
  request.catch((error: Error) => (failure = error.message));
  await vi.advanceTimersByTimeAsync(59_000);
  expect(failure).toBeNull();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(failure).toBe('Telegram did not answer within 60 seconds.');
});

// Detects: the request time limit cutting off a download that is slow but still receiving bytes.
it('lets a download run past the request time limit while it makes progress', async () => {
  const { client } = await signedInClient();
  const source = telegramSource(client);
  const [pack] = await source.readPacks(() => undefined);
  vi.useFakeTimers();
  const run = currentRun();
  let received = 0;
  let finish: () => void = () => undefined;
  const send = run.send.bind(run);
  run.send = (query) => {
    if (query['@type'] === 'downloadFile') return new Promise((resolve) => (finish = () => resolve({ '@type': 'ok' })));
    if (query['@type'] === 'getFile')
      return Promise.resolve({
        '@type': 'file',
        id: query.file_id,
        size: 1 << 20,
        expected_size: 1 << 20,
        local: { downloaded_size: (received += 1024) },
        remote: { unique_id: 'u1' },
      });
    return send(query);
  };
  let result: Uint8Array | null = null;
  void source.readFile(pack.stickers[0].fileId).then((bytes) => (result = bytes));
  await vi.advanceTimersByTimeAsync(90_000);
  expect(result).toBeNull();
  finish();
  await vi.advanceTimersByTimeAsync(10);
  expect(result).toEqual(bytesOf('u1'));
});

// Detects: a download sent again forever while TDLib stops at every run, leaving its pack "Downloading" for good.
it('stops sending a download again after TDLib stopped three times', async () => {
  const { client } = await signedInClient();
  const source = telegramSource(client);
  const [pack] = await source.readPacks(() => undefined);
  vi.useFakeTimers();
  SimulatedTdlib.onCreate = (run) => {
    run.holdDownloads = true;
  };
  currentRun().holdDownloads = true;
  let failure: string | null = null;
  source.readFile(pack.stickers[0].fileId).catch((error: Error) => (failure = error.message));
  for (let i = 0; i < 3; i++) {
    await vi.waitFor(() => expect(currentRun().sent).toContain('downloadFile'));
    currentRun().crash();
    await vi.advanceTimersByTimeAsync(40_000);
  }
  expect(failure).toBe('the Telegram connection was closed');
});

// Detects: a run-tagged file reference reading the wrong file (or failing) when TDLib crashes mid-download and
// renumbers files in the restarted run.
it('re-resolves TelegramFileRef via getRemoteFile when TDLib restarts mid-download', async () => {
  const { client } = await signedInClient();
  const ref = { run: client.run, fileId: currentRun().fileIdOf('u1'), remoteId: 'u1' };
  currentRun().holdDownloads = true;
  const reading = client.readFileRef(ref);
  await vi.waitFor(() => expect(currentRun().sent).toContain('downloadFile'));
  currentRun().crash();
  expect(await reading).toEqual(bytesOf('u1'));
  expect(currentRun().sent).toContain('getRemoteFile');

  // Streamed read via withFileRef also re-resolves stale run-1 references in run 2.
  const chunks: Uint8Array[] = [];
  await client.withFileRef(ref, async (_size, readChunks) => {
    await readChunks(async (chunk) => {
      chunks.push(chunk);
    });
  });
  expect(chunks).toEqual([bytesOf('u1')]);
});

// Detects: terminating a client while a restart is waiting for TDLib to report its state triggering an unhandled
// promise rejection from `#usable`.
it('terminates cleanly during a restart without an unhandled promise rejection', async () => {
  const { client } = await signedInClient();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    // Pause run 2 before it reports authorizationStateReady, then terminate the client.
    SimulatedTdlib.onCreate = (run) => {
      if (run.number === 2) {
        run.send = () => new Promise(() => undefined);
      }
    };
    currentRun().crash();
    await vi.waitFor(() => expect(SimulatedTdlib.runs.length).toBe(2));
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// Detects: withDownloadedFile continuing to send run 1's file_id in readFilePart and deleteFile to run 2 after a
// mid-stream restart (corrupting file contents or deleting an unrelated file in run 2).
it('aborts withDownloadedFile with TelegramRestartedError on mid-stream crash and never deletes run 1 file_id in run 2', async () => {
  const { client } = await signedInClient();
  const run1 = currentRun();
  const run1FileId = run1.fileIdOf('u1');
  let chunksSeen = 0;

  await expect(
    client.withDownloadedFile(
      run1FileId,
      async (_size, readChunks) => {
        await readChunks(async () => {
          chunksSeen++;
          if (chunksSeen === 1) run1.crash();
        });
      },
      2,
    ),
  ).rejects.toBeInstanceOf(TelegramRestartedError);

  // Wait for run 2 to become usable and verify run 2 never received readFilePart or deleteFile for run 1's file_id.
  await client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } });
  const run2 = currentRun();
  expect(run2.number).toBe(2);
  expect(run2.queries.filter((q) => q['@type'] === 'readFilePart')).toEqual([]);
  expect(run2.queries.filter((q) => q['@type'] === 'deleteFile')).toEqual([]);
});

// Detects: run 1's BroadcastChannel remaining open when run 2 starts on the same instanceName (causing tdweb's
// closeOtherClients handshake to deadlock forever waiting for run 1's terminated worker to answer 'closed').
it('closes run 1 BroadcastChannel before constructing run 2 after a fatal error', async () => {
  const { client } = await signedInClient();
  const run1 = currentRun();
  let run1ClosedWhenRun2Started: boolean | null = null;
  SimulatedTdlib.onCreate = (run) => {
    if (run.number === 2) run1ClosedWhenRun2Started = run1.channel.closed;
  };
  run1.crash();
  await client.invoke({ _: 'getInstalledStickerSets', sticker_type: { _: 'stickerTypeRegular' } });
  expect(run1.channel.closed).toBe(true);
  expect(run1ClosedWhenRun2Started).toBe(true);
});

// Detects: dispose() deleting IndexedDB while a slow loginCopies.restore() is still in flight, letting restore()
// finish afterwards and re-create /<instance>/dbfs on disk.
it('waits for an in-flight loginCopies.restore() before deleting IndexedDB in dispose()', async () => {
  const order: string[] = [];
  let finishRestore!: () => void;
  const slowCopies: LoginCopies = {
    save: async () => undefined,
    restore: async () => {
      order.push('restore:start');
      await new Promise<void>((resolve) => (finishRestore = resolve));
      order.push('restore:end');
      return true;
    },
  };
  vi.stubGlobal('indexedDB', {
    deleteDatabase: () => {
      order.push('deleteDatabase');
      const req: { onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  });
  try {
    const client = new TelegramClient(
      'telegram-0000000000000009',
      { apiId: 1, apiHash: 'simulated' },
      () => undefined,
      () => undefined,
      slowCopies,
    );
    await vi.waitFor(() => expect(order).toEqual(['restore:start']));
    const disposing = client.dispose();
    await new Promise((r) => setTimeout(r, 10));
    // deleteDatabase must not have run while restore() is still open.
    expect(order).toEqual(['restore:start']);
    finishRestore();
    await disposing;
    expect(order.indexOf('restore:end')).toBeLessThan(order.indexOf('deleteDatabase'));
  } finally {
    vi.unstubAllGlobals();
  }
});

// Detects: two concurrent readers of the same file deleting the local file while the slower reader is still reading.
it('keeps a downloaded file until all concurrent readers finish before deleting it', async () => {
  const { client } = await signedInClient();
  const run1 = currentRun();
  const fileId = run1.fileIdOf('u1');
  let releaseReader2!: () => void;
  const reader2Blocked = new Promise<void>((resolve) => (releaseReader2 = resolve));

  const reader2 = client.withDownloadedFile(
    fileId,
    async (_size, readChunks) => {
      await readChunks(async () => {
        await reader2Blocked;
      });
    },
    2,
  );
  const reader1 = client.readFile(fileId);
  await reader1;
  expect(run1.queries.filter((q) => q['@type'] === 'deleteFile')).toHaveLength(0);
  releaseReader2();
  await reader2;
  expect(run1.queries.filter((q) => q['@type'] === 'deleteFile')).toHaveLength(1);
});
