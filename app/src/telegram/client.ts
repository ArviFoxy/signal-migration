// The user's Telegram account, through TDLib running in the page (tdweb, built from third_party/td with the patches
// in scripts/tdweb).
//
// The page talks to Telegram directly; nothing goes through our server. Each login gets its own TDLib instance,
// named "telegram-<random>". An instance has three IndexedDB databases: TDLib's database directory, which holds the
// login; the downloaded files; and our own copy of the login. The workflow keeps the name of the current instance, so
// that a reload continues its login.
//
// Nothing here waits for TDLib to report that it closed, and nothing is saved when the page closes, because a page
// can be closed at any moment. The login is saved right after TDLib reports it (checkpoint): tdweb copies TDLib's
// database to IndexedDB, and the login file is then copied into our own database. Every start of an instance first
// writes that copy back, so the login does not depend on what TDLib wrote to its database since. An instance is
// removed by stopping its worker and deleting its databases.
//
// TDLib can stop after an internal error (tdweb then sends updateFatalError and answers nothing more). A client with
// a saved login restarts TDLib on the same instance from the copy, and those listening see no change in the login:
// requests sent meanwhile wait for the restart, and requests TDLib had not answered fail with TelegramRestartedError,
// so that the caller can send them again. TDLib numbers files anew in every run (`run`), so a file number from an
// earlier run must be looked up again (kinds/stickers/telegram-packs.ts).

import tdweb, { type TdClient as TdClientType, type TdObject } from 'tdweb';
import type * as Td from 'tdlib-types';
import { buildVerifier } from '../attestation/runtime';
import { tdlibFiles } from '../core/assets';
import { errorMessage } from '../core/errors';
import { randomHex } from '../core/random';
import { NoAnswerError, REQUEST_TIME_LIMIT_S, withTimeLimit } from '../core/time-limit';
import { downloadWithStallLimit } from './download';

const TdClient = tdweb.default;

/** The Telegram app identity TDLib logs in with, served by our server from its configuration. */
export type TelegramApp = { apiId: number; apiHash: string; testDc?: boolean };

export const newTelegramInstance = () => `telegram-${randomHex(8)}`;

// tdweb keeps TDLib's database directory in IndexedDB through Emscripten's IDBFS (library_idbfs.js): one database
// named after the directory, version 21, with one object store "FILE_DATA" indexed by "timestamp", holding each file
// under its full path as { timestamp, mode, contents }.
const IDBFS_VERSION = 21;
const IDBFS_STORE = 'FILE_DATA';
/** The file of TDLib's database directory that holds the login (with TDLib's other databases off, the only one). */
const LOGIN_FILE = 'td.binlog';

const tdlibDatabaseOf = (instance: string) => `/${instance}/dbfs`;
const loginCopyDatabaseOf = (instance: string) => `/${instance}/login`;

/** An instance's databases: the downloaded files under its name, TDLib's database, our copy of the login. */
const databasesOf = (instance: string) => [instance, tdlibDatabaseOf(instance), loginCopyDatabaseOf(instance)];

/** An instance's name from one of its database names; also matches the single instance "telegram" of older versions. */
const instanceOf = (database: string) =>
  /^\/?(telegram(?:-[0-9a-f]{16})?)(?:\/dbfs|\/login)?$/.exec(database)?.[1] ?? null;

/**
 * Deletes a database. While a connection to it is still open (a worker that was just stopped), the browser reports
 * "blocked" and deletes it once the connection closes; this waits for that.
 */
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Deletes everything an instance stored in this browser. */
export async function deleteTelegramInstance(instance: string): Promise<void> {
  await Promise.all(databasesOf(instance).map(deleteDatabase));
}

/** The TDLib instances that have databases in this browser. */
export async function telegramInstancesInBrowser(): Promise<string[]> {
  const names = (await indexedDB.databases()).map((database) => instanceOf(database.name ?? ''));
  return [...new Set(names.filter((name) => name !== null))];
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDatabase(name: string, version: number, create: (database: IDBDatabase) => void): Promise<IDBDatabase> {
  const request = indexedDB.open(name, version);
  request.onupgradeneeded = () => create(request.result);
  return result(request);
}

/** Opens TDLib's database as IDBFS does, creating it the same way when it does not exist. */
function openTdlibDatabase(instance: string): Promise<IDBDatabase> {
  return openDatabase(tdlibDatabaseOf(instance), IDBFS_VERSION, (database) =>
    database.createObjectStore(IDBFS_STORE).createIndex('timestamp', 'timestamp', { unique: false }),
  );
}

const openLoginCopyDatabase = (instance: string) =>
  openDatabase(loginCopyDatabaseOf(instance), 1, (database) => database.createObjectStore('files'));

/** Our own copy of an instance's login: the login file of TDLib's database, as IDBFS keeps it. */
export interface LoginCopies {
  /** Copies the login file from TDLib's database in IndexedDB into our own database. */
  save(instance: string): Promise<void>;
  /** Writes our copy back into TDLib's database, before TDLib starts; false when there is no copy. */
  restore(instance: string): Promise<boolean>;
}

export const indexedDbLoginCopies: LoginCopies = {
  async save(instance) {
    const tdlib = await openTdlibDatabase(instance);
    let file: unknown;
    try {
      const store = tdlib.transaction(IDBFS_STORE).objectStore(IDBFS_STORE);
      file = await result(store.get(`${tdlibDatabaseOf(instance)}/${LOGIN_FILE}`));
    } finally {
      tdlib.close();
    }
    if (!file) throw new Error('saving the Telegram login in this browser failed');
    const copies = await openLoginCopyDatabase(instance);
    try {
      const transaction = copies.transaction('files', 'readwrite');
      transaction.objectStore('files').put(file, LOGIN_FILE);
      await committed(transaction);
    } finally {
      copies.close();
    }
  },

  async restore(instance) {
    // Opening a database creates it, so whether a copy exists is read from the list of databases.
    const name = loginCopyDatabaseOf(instance);
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return false;
    const copies = await openLoginCopyDatabase(instance);
    let file: unknown;
    try {
      file = await result(copies.transaction('files').objectStore('files').get(LOGIN_FILE));
    } finally {
      copies.close();
    }
    if (!file) return false;
    const tdlib = await openTdlibDatabase(instance);
    try {
      const transaction = tdlib.transaction(IDBFS_STORE, 'readwrite');
      const store = transaction.objectStore(IDBFS_STORE);
      const path = `${tdlibDatabaseOf(instance)}/${LOGIN_FILE}`;
      store.put(file, path);
      // A rewrite of the login file that TDLib had not finished (Binlog::do_reindex in third_party/td).
      store.delete(`${path}.new`);
      await committed(transaction);
    } finally {
      tdlib.close();
    }
    return true;
  },
};

/**
 * tdweb names an object's type in the field '@type'; the generated types (tdl-install-types) name it '_'.
 * This renames the field throughout a plain JSON value, leaving Blobs and other non-plain objects alone.
 */
function renameTypeField(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => renameTypeField(item, from, to));
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key === from ? to : key, renameTypeField(item, from, to)]),
  );
}

const toTdweb = (query: object) => renameTypeField(query, '_', '@type') as TdObject;
const fromTdweb = (object: TdObject) => renameTypeField(object, '@type', '_') as { _: string };

/** An error TDLib returned for a request. */
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** A request TDLib did not answer because it stopped after an internal error; it can be sent again. */
export class TelegramRestartedError extends Error {
  constructor() {
    super('the Telegram connection was closed');
  }
}

/**
 * A run-tagged handle to a Telegram file: its TDLib file number from one run plus the permanent remote ID that lets
 * `TelegramClient.readFileRef` / `withFileRef` resolve a fresh number if TDLib restarts.
 */
export type TelegramFileRef = {
  /** The TDLib run that produced `fileId`, or 0 when the run is unknown / stale. */
  readonly run: number;
  readonly fileId: number;
  readonly remoteId: string;
};

/** Creates a run-tagged reference to a TDLib file object. */
export function fileRef(file: Td.file, run: number): TelegramFileRef {
  return { run, fileId: file.id, remoteId: file.remote?.id ?? '' };
}

/** The parts of tdweb's client that it does not declare: its worker, BroadcastChannel, and file reader DB. */
type TdwebInternals = {
  worker?: Worker;
  channel?: { onmessage?: unknown; close(): Promise<void> | void };
  fileManager?: { idb?: Promise<IDBDatabase> };
};

/** How many times an operation is sent again after TDLib's restarts cut it off, before it fails. */
const ATTEMPTS_ACROSS_RESTARTS = 3;

/** Runs `operation` again when a restart of TDLib cut it off, at most ATTEMPTS_ACROSS_RESTARTS times in all. */
export async function untilNotRestarted<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TelegramRestartedError) || attempt >= ATTEMPTS_ACROSS_RESTARTS) throw error;
    }
  }
}

/** How long each restart after an internal error waits; a restart that fails again before signing in waits longer. */
const RESTART_DELAYS_MS = [0, 1_000, 5_000, 30_000];

const waitOrStop = (ms: number, stopped: Promise<never>): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void stopped.catch(() => {
      clearTimeout(timer);
      resolve();
    });
  });

export class TelegramClient {
  /** TDLib in its current run. */
  #td: TdClientType | null = null;
  /** How many times TDLib was started in this client; file numbers are valid only in the run that gave them. */
  #run = 0;
  /** Fails the requests sent to the current run when it stops. */
  #runEnded: Promise<never> = new Promise<never>(() => undefined);
  #endRun: (error: Error) => void = () => undefined;
  /** Resolves once the current run takes requests: after a restart, once TDLib has reported its login state. */
  #usable: Promise<void>;
  /** In-flight startup/restore work that must finish before dispose() deletes IndexedDB. */
  #startupWork: Promise<void> | null = null;
  /** In-flight termination of the previous run's worker, BroadcastChannel, and fileManager IDB. */
  #prevCleanup: Promise<void> = Promise.resolve();
  /** Reference count of active readers per `${run}:${fileId}` so deleteFile waits for sibling readers. */
  #activeFileReaders = new Map<string, number>();
  /** Fails every request once the client has stopped for good. */
  #stopped: Promise<never>;
  #stop: (error: Error) => void = () => undefined;
  #isStopped = false;
  /** Our copy of the login exists, so TDLib can be restarted without losing it. */
  #hasLoginCopy = false;
  /** The login state last passed on; a restart that signs in again does not pass on "ready" a second time. */
  #lastReported: Td.AuthorizationState['_'] | null = null;
  #failedRestarts = 0;

  /**
   * Starts TDLib on `instance`: a new one, or one whose login an earlier visit kept. `onFatalError` gets TDLib's
   * error message, and whether TDLib was restarted with the login; when it was not, this client has stopped.
   */
  constructor(
    readonly instance: string,
    private readonly app: TelegramApp,
    private readonly onAuthorizationState: (state: Td.AuthorizationState) => void,
    private readonly onFatalError: (error: string, restarted: boolean) => void,
    private readonly loginCopies: LoginCopies = indexedDbLoginCopies,
  ) {
    this.#stopped = new Promise<never>((_, reject) => (this.#stop = reject));
    this.#stopped.catch(() => undefined);
    this.#usable = this.#beginRun(0, Promise.resolve());
  }

  get run(): number {
    return this.#run;
  }

  /**
   * Advances `#run` synchronously before async startup begins so any caller woken by a restart immediately observes
   * the new run epoch and never reuses a file or chat handle from the previous run.
   */
  #beginRun(delayMs: number, prevCleanup: Promise<void>): Promise<void> {
    const run = ++this.#run;
    this.#activeFileReaders.clear();
    const usable = this.#startRun(run, delayMs, prevCleanup);
    usable.catch(() => undefined);
    return usable;
  }

  /** Writes our copy of the login back and starts TDLib; after a restart, waits until TDLib reports its state. */
  async #startRun(run: number, delayMs: number, prevCleanup: Promise<void>): Promise<void> {
    const preStart = (async () => {
      await prevCleanup.catch(() => undefined);
      if (delayMs > 0) await waitOrStop(delayMs, this.#stopped);
      if (this.#isStopped || run !== this.#run) return false;
      const files = tdlibFiles();
      if (files.length > 0) {
        try {
          await Promise.all(files.map((file) => buildVerifier.verifyAsset(file, import.meta.url)));
        } catch (error) {
          this.#isStopped = true;
          const message = errorMessage(error);
          this.#stop(new Error(message));
          this.onFatalError(message, false);
          return false;
        }
        if (this.#isStopped || run !== this.#run) return false;
      }
      // Without a copy (a new login, or one whose copy could not be read), TDLib's own database is used.
      if (await this.loginCopies.restore(this.instance).catch(() => false)) this.#hasLoginCopy = true;
      return !this.#isStopped && run === this.#run;
    })();
    const tracked = preStart.then(
      () => undefined,
      () => undefined,
    );
    this.#startupWork = tracked;
    const readyToStart = await preStart;
    if (this.#startupWork === tracked) this.#startupWork = null;
    if (!readyToStart) return;
    const runEnded = new Promise<never>((_, reject) => (this.#endRun = reject));
    runEnded.catch(() => undefined);
    this.#runEnded = runEnded;
    let markReported: () => void = () => undefined;
    const reported = new Promise<void>((resolve) => (markReported = resolve));
    this.#td = new TdClient({
      instanceName: this.instance,
      useDatabase: false,
      jsLogVerbosityLevel: 'error',
      logVerbosityLevel: 1,
      onUpdate: (raw) => this.#onUpdate(run, fromTdweb(raw), markReported),
    });
    // Wait until the restarted TDLib reports its state, stops for good, or crashes before reporting (so `#sendOnce`
    // moves on to the next run's `#usable`).
    if (run > 1) await Promise.race([reported, this.#stopped, runEnded.catch(() => undefined)]);
  }

  #onUpdate(run: number, update: { _: string }, markReported: () => void): void {
    if (run !== this.#run || this.#isStopped) return;
    if (update._ === 'updateFatalError') {
      const error = (update as { error?: unknown }).error;
      this.#onFatal(errorMessage(error));
      return;
    }
    if (update._ !== 'updateAuthorizationState') return;
    const state = (update as Td.updateAuthorizationState).authorization_state;
    if (state._ === 'authorizationStateWaitTdlibParameters') {
      void this.#sendParameters(this.#td!);
      // After a restart, those listening keep the state TDLib had before it stopped.
      if (run > 1) return;
    } else {
      markReported();
    }
    if (state._ === 'authorizationStateReady') this.#failedRestarts = 0;
    if (state._ === 'authorizationStateReady' && this.#lastReported === 'authorizationStateReady') return;
    this.#lastReported = state._;
    this.onAuthorizationState(state);
  }

  /**
   * TDLib stopped: restarts it when it holds a login (from our copy, or, for a login saved before copies were kept,
   * from TDLib's own database), and otherwise stops this client. A stopped client's waiting requests fail with the
   * ordinary error, since sending them again cannot succeed.
   */
  #onFatal(error: string): void {
    const restarted = this.#hasLoginCopy || this.#lastReported === 'authorizationStateReady';
    const endRun = this.#endRun;
    const td = this.#td;
    this.#td = null;
    const cleanup = this.#terminateWorker(td);
    this.#prevCleanup = cleanup;
    if (!restarted) {
      this.#isStopped = true;
      this.#stop(new Error('the Telegram connection was closed'));
    } else {
      const delay = RESTART_DELAYS_MS[Math.min(this.#failedRestarts++, RESTART_DELAYS_MS.length - 1)];
      this.#usable = this.#beginRun(delay, cleanup);
    }
    endRun(new TelegramRestartedError());
    this.onFatalError(error, restarted);
  }

  /**
   * Stops a run's worker, closes its BroadcastChannel so a restarted run on the same instanceName does not deadlock
   * in tdweb's closeOtherClients() handshake, and closes its file reader's IndexedDB connection.
   */
  async #terminateWorker(td: TdClientType | null): Promise<void> {
    const internals = td as unknown as TdwebInternals | null;
    if (!internals) return;
    if (internals.channel) {
      internals.channel.onmessage = null;
      await Promise.resolve(internals.channel.close()).catch(() => undefined);
    }
    internals.worker?.terminate();
    (await internals.fileManager?.idb?.catch(() => undefined))?.close();
  }

  async #sendParameters(td: TdClientType): Promise<void> {
    const app = this.app;
    await td
      .send(
        toTdweb({
          _: 'setTdlibParameters',
          use_test_dc: app.testDc ?? false,
          // tdweb sets the directories and turns the databases on or off from its own options.
          database_directory: '',
          files_directory: '',
          database_encryption_key: '',
          use_file_database: false,
          use_chat_info_database: false,
          use_message_database: false,
          use_secret_chats: false,
          api_id: app.apiId,
          api_hash: app.apiHash,
          system_language_code: navigator.language,
          device_model: 'Web browser',
          system_version: '',
          application_version: 'Signal migration',
        }),
      )
      .catch(() => undefined);
  }

  /**
   * Sends one request to TDLib's current run, once it takes requests. Fails at once if the client has stopped, with
   * TelegramRestartedError if TDLib stops before answering, and with a NoAnswerError when there is no answer within
   * the request time limit, waiting for a restart included. A download has no such limit: it may take long while it
   * makes progress, and download.ts limits how long it may make none. tdweb rejects a failed request with TDLib's
   * error object, which is turned into a TelegramError here.
   */
  #send(query: TdObject, pinnedRun?: number): Promise<TdObject> {
    const answer = this.#sendOnce(query, pinnedRun);
    if (query['@type'] === 'downloadFile') return answer;
    return withTimeLimit(
      answer,
      REQUEST_TIME_LIMIT_S * 1000,
      () => new NoAnswerError('Telegram', REQUEST_TIME_LIMIT_S),
    );
  }

  async #sendOnce(query: TdObject, pinnedRun?: number): Promise<TdObject> {
    let usable: Promise<void>;
    do {
      if (pinnedRun !== undefined && this.#run !== pinnedRun) throw new TelegramRestartedError();
      usable = this.#usable;
      // A stopped client comes first: its last run may have ended before TDLib started.
      await Promise.race([this.#stopped, usable]);
      if (pinnedRun !== undefined && this.#run !== pinnedRun) throw new TelegramRestartedError();
    } while (usable !== this.#usable);
    if (this.#isStopped || !this.#td) throw new Error('the Telegram connection was closed');
    if (pinnedRun !== undefined && this.#run !== pinnedRun) throw new TelegramRestartedError();
    const runAtSend = this.#run;
    const response = await Promise.race([this.#stopped, this.#runEnded, this.#td.send(query)]).catch(
      (error: unknown) => {
        const tdError = error as { '@type'?: string; code?: number; message?: string } | null;
        if (tdError?.['@type'] === 'error')
          throw new TelegramError(tdError.code ?? 0, tdError.message ?? 'unknown error');
        throw error;
      },
    );
    if (pinnedRun !== undefined && this.#run !== runAtSend) throw new TelegramRestartedError();
    return response;
  }

  /** Sends one TDLib request and returns its result; a TDLib error is thrown as a TelegramError. */
  invoke: Td.Invoke = async (query) => {
    const result = fromTdweb(await this.#send(toTdweb(query)));
    if (result._ === 'error') {
      const error = result as Td.error;
      throw new TelegramError(error.code, error.message);
    }
    return result as never;
  };

  /**
   * Sends one TDLib request pinned to `run`. Fails immediately with `TelegramRestartedError` if TDLib is already on
   * another run or restarts before answering, so run-scoped IDs (file IDs, in-memory chats) never cross runs.
   */
  invokeInRun = async <T extends Td.$FunctionName>(
    run: number,
    query: { readonly _: T } & Td.$FunctionInputByName[T],
  ): Promise<Td.$FunctionResultByName[T]> => {
    const result = fromTdweb(await this.#send(toTdweb(query), run));
    if (result._ === 'error') {
      const error = result as Td.error;
      throw new TelegramError(error.code, error.message);
    }
    return result as Td.$FunctionResultByName[T];
  };

  #acquireFileReader(run: number, fileId: number): string {
    const key = `${run}:${fileId}`;
    this.#activeFileReaders.set(key, (this.#activeFileReaders.get(key) ?? 0) + 1);
    return key;
  }

  async #releaseFileReader(run: number, fileId: number, key: string): Promise<void> {
    const count = (this.#activeFileReaders.get(key) ?? 1) - 1;
    if (count > 0) {
      this.#activeFileReaders.set(key, count);
      return;
    }
    this.#activeFileReaders.delete(key);
    if (this.#isStopped || this.#run !== run) return;
    await this.#send({ '@type': 'deleteFile', file_id: fileId }, run).catch(() => undefined);
  }

  /**
   * Downloads a file and returns its bytes, then deletes the downloaded copy once no sibling reader is using it.
   * `fileId` is pinned to `run` (defaults to the current run) so a restart never reads or deletes a file from a
   * newer run. A download that receives nothing for a minute is cancelled (download.ts).
   */
  async readFile(fileId: number, run: number = this.#run, cancel?: AbortSignal): Promise<Uint8Array> {
    const pinnedInvoke = ((query: Parameters<Td.Invoke>[0]) => this.invokeInRun(run, query)) as Td.Invoke;
    const readerKey = this.#acquireFileReader(run, fileId);
    try {
      await downloadWithStallLimit(pinnedInvoke, fileId, undefined, undefined, cancel);
      const part = (await this.#send({ '@type': 'readFile', file_id: fileId }, run)) as TdObject & {
        data?: Blob;
        message?: unknown;
      };
      if (part['@type'] !== 'filePart' || !(part.data instanceof Blob))
        throw new Error(`reading a downloaded Telegram file failed: ${String(part.message)}`);
      return new Uint8Array(await part.data.arrayBuffer());
    } finally {
      await this.#releaseFileReader(run, fileId, readerKey);
    }
  }

  /**
   * Downloads a file, passes its exact byte length and a chunked reader (via `readFilePart`) to `use`, and deletes
   * the local copy when `use` finishes or throws (once no sibling reader is using it). Pinned to `run` so a restart
   * never reads chunks from or deletes an unrelated file in a later run.
   */
  async withDownloadedFile<T>(
    fileId: number,
    use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
    chunkBytes = 2 * 1024 * 1024,
    run: number = this.#run,
    cancel?: AbortSignal,
    onWaiting?: (waiting: boolean) => void,
  ): Promise<T> {
    const pinnedInvoke = ((query: Parameters<Td.Invoke>[0]) => this.invokeInRun(run, query)) as Td.Invoke;
    const readerKey = this.#acquireFileReader(run, fileId);
    try {
      await downloadWithStallLimit(pinnedInvoke, fileId, undefined, undefined, cancel, onWaiting);
      const file = await this.invokeInRun(run, { _: 'getFile', file_id: fileId });
      const size = file.local.downloaded_size || file.size;
      return await use(size, async (onChunk) => {
        for (let offset = 0; offset < size; offset += chunkBytes) {
          cancel?.throwIfAborted();
          const count = Math.min(chunkBytes, size - offset);
          const part = (await this.#send(
            {
              '@type': 'readFilePart',
              file_id: fileId,
              offset,
              count,
            },
            run,
          )) as TdObject & { data?: Blob; message?: unknown };
          if (part['@type'] !== 'filePart' || !(part.data instanceof Blob))
            throw new Error(`reading a downloaded Telegram file failed: ${String(part.message)}`);
          await onChunk(new Uint8Array(await part.data.arrayBuffer()));
        }
      });
    } finally {
      await this.#releaseFileReader(run, fileId, readerKey);
    }
  }

  async #resolveFileId(ref: TelegramFileRef): Promise<{ run: number; fileId: number }> {
    // Wait for any in-progress restart to settle before reading `#run`.
    let usable: Promise<void>;
    do {
      usable = this.#usable;
      await Promise.race([this.#stopped, usable]);
    } while (usable !== this.#usable);
    const run = this.#run;
    if (ref.run > 0 && ref.run === run) return { run, fileId: ref.fileId };
    if (!ref.remoteId) throw new Error('the Telegram file cannot be read after Telegram restarted');
    const file = await this.invokeInRun(run, { _: 'getRemoteFile', remote_file_id: ref.remoteId });
    return { run, fileId: file.id };
  }

  /**
   * Downloads a file identified by a run-tagged reference and returns its bytes, re-resolving it via `getRemoteFile`
   * if TDLib restarted since the reference was created, and retrying across restarts.
   */
  readFileRef(ref: TelegramFileRef, cancel?: AbortSignal): Promise<Uint8Array> {
    return untilNotRestarted(async () => {
      cancel?.throwIfAborted();
      const { run, fileId } = await this.#resolveFileId(ref);
      return this.readFile(fileId, run, cancel);
    });
  }

  /**
   * Downloads a file identified by a run-tagged reference and streams its bytes to `use`, re-resolving it via
   * `getRemoteFile` if TDLib restarted since the reference was created, and retrying across restarts.
   */
  withFileRef<T>(
    ref: TelegramFileRef,
    use: (size: number, readChunks: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>) => Promise<T>,
    chunkBytes = 2 * 1024 * 1024,
    cancel?: AbortSignal,
    onWaiting?: (waiting: boolean) => void,
  ): Promise<T> {
    return untilNotRestarted(async () => {
      cancel?.throwIfAborted();
      const { run, fileId } = await this.#resolveFileId(ref);
      return this.withDownloadedFile(fileId, use, chunkBytes, run, cancel, onWaiting);
    });
  }

  /**
   * Saves the login in this browser now: tdweb copies TDLib's database to IndexedDB (the "syncDatabase" request of
   * our tdweb patch), then the login file is copied into our own database.
   */
  async checkpoint(): Promise<void> {
    const result = await this.#send({ '@type': 'syncDatabase' });
    if (result['@type'] !== 'ok') throw new Error('saving the Telegram login in this browser failed');
    await this.loginCopies.save(this.instance);
    this.#hasLoginCopy = true;
  }

  /**
   * Ends the session on Telegram's side. TDLib answers once Telegram has answered the logout request and TDLib has
   * destroyed its keys (AuthManager::on_log_out_result in third_party/td). A logout that a restart cut off is sent
   * again.
   */
  logOut(): Promise<void> {
    return untilNotRestarted(async () => void (await this.invoke({ _: 'logOut' })));
  }

  /** Stops TDLib's worker now and keeps the instance's databases, for TDLib to start on them again. */
  terminate(): void {
    this.#isStopped = true;
    this.#activeFileReaders.clear();
    const td = this.#td;
    this.#td = null;
    this.#stop(new Error('the Telegram connection was closed'));
    void this.#terminateWorker(td);
  }

  /** Stops TDLib's worker now and deletes the instance's databases. Requests still waiting fail. */
  async dispose(): Promise<void> {
    this.#isStopped = true;
    this.#activeFileReaders.clear();
    this.#stop(new Error('the Telegram connection was closed'));
    // Wait for any in-flight startup/restore to finish so it cannot re-create IndexedDB after we delete it.
    await this.#startupWork?.catch(() => undefined);
    const td = this.#td;
    this.#td = null;
    await Promise.all([this.#prevCleanup.catch(() => undefined), this.#terminateWorker(td)]);
    await deleteTelegramInstance(this.instance);
  }
}
