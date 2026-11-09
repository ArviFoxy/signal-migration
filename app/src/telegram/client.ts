// The user's Telegram account, through TDLib running in the page (tdweb, built from third_party/td with the patches
// in scripts/tdweb).
//
// The page talks to Telegram directly; nothing goes through our server. Each login gets its own TDLib instance,
// named "telegram-<random>", with two IndexedDB databases: TDLib's database directory, which holds the login, and
// the downloaded files. The workflow keeps the name of the current instance, so that a reload continues its login.
//
// Nothing here waits for TDLib to report that it closed, and nothing is saved when the page closes, because a page
// can be closed at any moment. The login is saved to IndexedDB right after TDLib reports it (checkpoint). An instance
// is removed by stopping its worker and deleting its databases.

import tdweb, { type TdClient as TdClientType, type TdObject } from 'tdweb';
import type * as Td from 'tdlib-types';
import { downloadWithStallLimit } from './download';

const TdClient = tdweb.default;

/** The Telegram app identity TDLib logs in with, served by our server from its configuration. */
export type TelegramApp = { apiId: number; apiHash: string; testDc?: boolean };

const randomHex = (byteCount: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(byteCount)), (b) => b.toString(16).padStart(2, '0')).join('');

export const newTelegramInstance = () => `telegram-${randomHex(8)}`;

/** tdweb's IndexedDB databases for an instance: downloaded files under its name, the database directory under its path. */
const databasesOf = (instance: string) => [instance, `/${instance}/dbfs`];

/** An instance's name from one of its database names; also matches the single instance "telegram" of older versions. */
const instanceOf = (database: string) => /^\/?(telegram(?:-[0-9a-f]{16})?)(?:\/dbfs)?$/.exec(database)?.[1] ?? null;

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

/** The parts of tdweb's client that it does not declare: its worker and the file reader's database connection. */
type TdwebInternals = { worker?: Worker; fileManager?: { idb?: Promise<IDBDatabase> } };

export class TelegramClient {
  #client: TdClientType;
  #stopped: Promise<never>;
  #stop: (error: Error) => void = () => undefined;

  /** Starts TDLib on `instance`: a new one, or one whose login an earlier visit kept. */
  constructor(
    readonly instance: string,
    app: TelegramApp,
    onAuthorizationState: (state: Td.AuthorizationState) => void,
  ) {
    this.#stopped = new Promise<never>((_, reject) => (this.#stop = reject));
    this.#stopped.catch(() => undefined);
    this.#client = new TdClient({
      instanceName: instance,
      useDatabase: false,
      jsLogVerbosityLevel: 'error',
      logVerbosityLevel: 1,
      onUpdate: (raw) => {
        const update = fromTdweb(raw) as Td.Update;
        if (update._ !== 'updateAuthorizationState') return;
        const state = update.authorization_state;
        if (state._ === 'authorizationStateWaitTdlibParameters') void this.#sendParameters(app);
        onAuthorizationState(state);
      },
    });
  }

  async #sendParameters(app: TelegramApp): Promise<void> {
    await this.invoke({
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
    });
  }

  /**
   * Sends one request to tdweb; fails at once if the client was stopped. tdweb rejects a failed request with TDLib's
   * error object, which is turned into a TelegramError here.
   */
  #send(query: TdObject): Promise<TdObject> {
    return Promise.race([this.#client.send(query), this.#stopped]).catch((error: unknown) => {
      const tdError = error as { '@type'?: string; code?: number; message?: string } | null;
      if (tdError?.['@type'] === 'error')
        throw new TelegramError(tdError.code ?? 0, tdError.message ?? 'unknown error');
      throw error;
    });
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
   * Downloads a file and returns its bytes, then deletes the downloaded copy. A download that receives nothing for
   * a minute is cancelled (download.ts).
   */
  async readFile(fileId: number): Promise<Uint8Array> {
    await downloadWithStallLimit(this.invoke, fileId);
    const part = (await this.#send({ '@type': 'readFile', file_id: fileId })) as TdObject & {
      data?: Blob;
      message?: unknown;
    };
    if (part['@type'] !== 'filePart' || !(part.data instanceof Blob))
      throw new Error(`reading a downloaded Telegram file failed: ${String(part.message)}`);
    const bytes = new Uint8Array(await part.data.arrayBuffer());
    await this.#send({ '@type': 'deleteFile', file_id: fileId });
    return bytes;
  }

  /** Copies TDLib's database, with the login, to IndexedDB now (the "syncDatabase" request of our tdweb patch). */
  async checkpoint(): Promise<void> {
    const result = await this.#send({ '@type': 'syncDatabase' });
    if (result['@type'] !== 'ok') throw new Error('saving the Telegram login in this browser failed');
  }

  /**
   * Ends the session on Telegram's side. TDLib answers once Telegram has answered the logout request and TDLib has
   * destroyed its keys (AuthManager::on_log_out_result in third_party/td).
   */
  async logOut(): Promise<void> {
    await this.invoke({ _: 'logOut' });
  }

  /** Stops TDLib's worker now and deletes the instance's databases. Requests still waiting fail. */
  async dispose(): Promise<void> {
    this.#stop(new Error('the Telegram connection was closed'));
    const internals = this.#client as unknown as TdwebInternals;
    internals.worker?.terminate();
    (await internals.fileManager?.idb?.catch(() => undefined))?.close();
    await deleteTelegramInstance(this.instance);
  }
}
