// The user's Telegram account, through TDLib running in the page (tdweb, built from third_party/td).
//
// The page talks to Telegram directly; nothing goes through our server. The user logs in on each visit and
// nothing is kept afterwards:
// - TDLib's database directory, which holds the login, lives in memory only. tdweb mounts it on an IndexedDB
//   database and copies it there every few seconds; the `readOnly` option turns that copying off.
// - Downloaded files go to a second IndexedDB database. The files are public sticker images; they are deleted
//   once read, and the whole database is deleted when the session ends.
// Both databases are also deleted at start, in case an earlier visit ended without logging out.

import tdweb, { type TdClient as TdClientType, type TdObject } from 'tdweb';
import type * as Td from 'tdlib-types';

const TdClient = tdweb.default;

/** The Telegram app identity TDLib logs in with, served by our server from its configuration. */
export type TelegramApp = { apiId: number; apiHash: string };

const INSTANCE_NAME = 'telegram';
/** tdweb's IndexedDB databases: downloaded files under the instance name, the database directory under its path. */
const DATABASES = [INSTANCE_NAME, `/${INSTANCE_NAME}/dbfs`];

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

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`the local database ${name} is still open in another tab`));
  });
}

/** Deletes everything tdweb stored in this browser. */
export async function eraseTelegramData(): Promise<void> {
  await Promise.all(DATABASES.map(deleteDatabase));
}

/** An error TDLib returned for a request. */
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class TelegramClient {
  #client: TdClientType;
  #closed: Promise<void>;

  private constructor(app: TelegramApp, onAuthorizationState: (state: Td.AuthorizationState) => void) {
    let markClosed: () => void = () => undefined;
    this.#closed = new Promise((resolve) => (markClosed = resolve));
    this.#client = new TdClient({
      instanceName: INSTANCE_NAME,
      useDatabase: false,
      readOnly: true,
      jsLogVerbosityLevel: 'error',
      logVerbosityLevel: 1,
      onUpdate: (raw) => {
        const update = fromTdweb(raw) as Td.Update;
        if (update._ !== 'updateAuthorizationState') return;
        const state = update.authorization_state;
        if (state._ === 'authorizationStateWaitTdlibParameters') void this.#sendParameters(app);
        if (state._ === 'authorizationStateClosed') markClosed();
        onAuthorizationState(state);
      },
    });
  }

  /**
   * Starts TDLib after deleting anything an earlier visit left behind. `onAuthorizationState` is called with each
   * login state, and with the closing states after `logOut`.
   */
  static async start(
    app: TelegramApp,
    onAuthorizationState: (state: Td.AuthorizationState) => void,
  ): Promise<TelegramClient> {
    await eraseTelegramData();
    return new TelegramClient(app, onAuthorizationState);
  }

  async #sendParameters(app: TelegramApp): Promise<void> {
    await this.invoke({
      _: 'setTdlibParameters',
      use_test_dc: false,
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

  /** Sends one TDLib request and returns its result; a TDLib error is thrown as a TelegramError. */
  invoke: Td.Invoke = async (query) => {
    const result = fromTdweb(await this.#client.send(toTdweb(query)));
    if (result._ === 'error') {
      const error = result as Td.error;
      throw new TelegramError(error.code, error.message);
    }
    return result as never;
  };

  /** Downloads a file and returns its bytes, then deletes the downloaded copy. */
  async readFile(fileId: number): Promise<Uint8Array> {
    await this.invoke({ _: 'downloadFile', file_id: fileId, priority: 1, offset: 0, limit: 0, synchronous: true });
    const part = (await this.#client.send({ '@type': 'readFile', file_id: fileId })) as TdObject & {
      data?: Blob;
      message?: unknown;
    };
    if (part['@type'] !== 'filePart' || !(part.data instanceof Blob))
      throw new Error(`reading a downloaded Telegram file failed: ${String(part.message)}`);
    const bytes = new Uint8Array(await part.data.arrayBuffer());
    await this.#client.send({ '@type': 'deleteFile', file_id: fileId });
    return bytes;
  }

  /** Ends the Telegram session (it disappears from the account's active sessions) and erases the local data. */
  async logOut(): Promise<void> {
    await this.invoke({ _: 'logOut' }).catch(() => this.invoke({ _: 'close' }));
    await this.#erase();
  }

  /** Stops TDLib without ending a session; for a login that never completed. */
  async close(): Promise<void> {
    await this.invoke({ _: 'close' }).catch(() => undefined);
    await this.#erase();
  }

  async #erase(): Promise<void> {
    await this.#closed;
    // tdweb ends its worker on close, which closes the worker's database connections, but its file reader in the
    // page keeps one open (FileManager.idb in tdweb's src/index.js). A database cannot be deleted while open.
    const fileManager = (this.#client as unknown as { fileManager?: { idb?: Promise<IDBDatabase> } }).fileManager;
    (await fileManager?.idb)?.close();
    await eraseTelegramData();
  }
}
