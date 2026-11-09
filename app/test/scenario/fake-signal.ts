// A simulated Signal service: accounts with linked devices, the storage service, sticker upload forms with the
// per-account upload limit, and the sticker CDN.
//
// Like the real storage service, it never decrypts anything: it keeps the manifest and the records as opaque
// blobs, and accepts a write only on top of the current manifest version. The CDN accepts an upload only for a
// key that an upload form issued, within the policy's lifetime and size limit, and stores the bytes it is given.
// Faults (a failing request) and other devices' changes (before a storage write) can be scheduled.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ReadOperationSchema,
  StorageItemSchema,
  StorageItemsSchema,
  StorageManifestSchema,
  WriteOperationSchema,
} from '../../src/gen/SignalStorage_pb';
import { SocketClosedError } from '../../src/signal/socket';
import type { ChatChannel, ChatResponse, HttpResponse, HttpsRequest } from '../../src/signal/transport';
import type { Clock } from '../../src/core/clock';
import { hex } from './bytes';
import { parseMultipart } from './multipart';

const encoder = new TextEncoder();
/** The close code of a removed device's connection. */
const DEVICE_REMOVED = 4401;
/** Signal-Server's limits for sticker uploads (StickerController.java, PostPolicyGenerator.java). */
const MAX_ENCRYPTED_STICKER = 301 * 1024;
const MAX_ENCRYPTED_MANIFEST = 10 * 1024;
const POLICY_LIFETIME_MS = 30 * 60_000;

type Account = {
  storage: { version: bigint; manifest: Uint8Array | null; items: Map<string, Uint8Array> };
  storageLogin: { username: string; password: string };
  devices: Map<number, { linked: boolean }>;
  nextDeviceId: number;
  /** Sticker pack upload allowance, refilled one per interval up to the burst. */
  uploadTokens: number;
  uploadTokensAt: number;
};

type Fault = { matches: (request: string) => boolean; remaining: number };

/** A seeded generator (mulberry32), so that pack IDs repeat from run to run. */
function seededBytes(seed: number) {
  let state = seed;
  return (count: number) =>
    Uint8Array.from({ length: count }, () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) & 0xff;
    });
}

const chatJson = (status: number, value: unknown): ChatResponse => ({
  status,
  message: status === 200 ? 'OK' : 'Error',
  headers: [],
  body: encoder.encode(JSON.stringify(value)),
});
const httpResponse = (
  status: number,
  body = new Uint8Array(0),
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  body,
  header: (name) => headers[name.toLowerCase()],
});

export type UploadLimit = { burst: number; intervalMs: number };

export class FakeSignal {
  #accounts = new Map<string, Account>();
  #random = seededBytes(7);
  #policies = new Map<string, { expires: number; maxBytes: number; account: string }>();
  #cdn = new Map<string, Uint8Array>();
  #faults: Fault[] = [];
  #beforeStorageWrite: (() => Promise<void>)[] = [];
  /** Sticker pack upload forms issued, and manifests stored, per account. */
  formsIssued = new Map<string, number>();
  packsUploaded = new Map<string, number>();
  storageWrites = 0;
  /** Chat requests from devices that were unlinked, which the server refuses by closing the connection. */
  requestsFromUnlinkedDevices = 0;

  constructor(
    readonly clock: Pick<Clock, 'now'>,
    /** The upload limit of accounts created from now on. */
    public uploadLimit: UploadLimit = { burst: 50, intervalMs: 72 * 60_000 },
  ) {}

  /** A new account ID, made at random so that no real-looking identifier is written into the tests. */
  createAccount(): string {
    const aci = hex(this.#random(16));
    this.#accounts.set(aci, {
      storage: { version: 0n, manifest: null, items: new Map() },
      storageLogin: { username: `storage-${aci}`, password: hex(this.#random(16)) },
      devices: new Map([[1, { linked: true }]]),
      nextDeviceId: 2,
      uploadTokens: this.uploadLimit.burst,
      uploadTokensAt: this.clock.now(),
    });
    return aci;
  }

  #account(aci: string): Account {
    const account = this.#accounts.get(aci);
    if (!account) throw new Error('no such account');
    return account;
  }

  linkDevice(aci: string): number {
    const account = this.#account(aci);
    const deviceId = account.nextDeviceId++;
    account.devices.set(deviceId, { linked: true });
    return deviceId;
  }

  /**
   * What the account's other devices were told by sync messages: each sticker pack install (pack ID and key in hex)
   * and how many times they were asked to read the storage service again. Messages from an unlinked device are
   * refused, as the server refuses them.
   */
  readonly toldInstalled = new Map<string, string[]>();
  readonly toldToFetchStorage = new Map<string, number>();
  /** The next `count` attempts to message the other devices fail, as a network failure would. */
  failAnnouncements = 0;

  deliverToOtherDevices(aci: string, fromDevice: number, packs: { packId: Uint8Array; packKey: Uint8Array }[]): void {
    if (!this.isLinked(aci, fromDevice)) throw new SocketClosedError(DEVICE_REMOVED);
    if (this.failAnnouncements > 0) {
      this.failAnnouncements--;
      throw new Error('the connection to Signal closed');
    }
    const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const told = this.toldInstalled.get(aci) ?? [];
    for (const { packId, packKey } of packs) told.push(`${hex(packId)}:${hex(packKey)}`);
    this.toldInstalled.set(aci, told);
    this.toldToFetchStorage.set(aci, (this.toldToFetchStorage.get(aci) ?? 0) + 1);
  }

  unlinkDevice(aci: string, deviceId: number): void {
    this.#account(aci).devices.set(deviceId, { linked: false });
  }

  /** The IDs of every device the account has had, the primary device (1) included. */
  devices(aci: string): number[] {
    return [...this.#account(aci).devices.keys()];
  }

  isLinked(aci: string, deviceId: number): boolean {
    return this.#account(aci).devices.get(deviceId)?.linked ?? false;
  }

  /** The next `count` requests whose description ("chat GET /path" or "https POST host /path") matches fail. */
  failNext(matches: (request: string) => boolean, count = 1): void {
    this.#faults.push({ matches, remaining: count });
  }

  /** Runs `change` once, just before the next storage write is applied, as another device writing first would. */
  beforeNextStorageWrite(change: () => Promise<void>): void {
    this.#beforeStorageWrite.push(change);
  }

  #checkFaults(request: string): void {
    const fault = this.#faults.find((candidate) => candidate.remaining > 0 && candidate.matches(request));
    if (fault) {
      fault.remaining--;
      throw new Error(`simulated network failure: ${request}`);
    }
  }

  /** The chat connection of a linked device. */
  chat(aci: string, deviceId: number): ChatChannel {
    return {
      request: async (verb, path) => {
        if (!this.isLinked(aci, deviceId)) {
          this.requestsFromUnlinkedDevices++;
          throw new SocketClosedError(DEVICE_REMOVED);
        }
        this.#checkFaults(`chat ${verb} ${path}`);
        const account = this.#account(aci);
        if (verb === 'GET' && path === '/v1/storage/auth') return chatJson(200, account.storageLogin);
        const form = /^\/v1\/sticker\/pack\/form\/(\d+)$/.exec(path);
        if (verb === 'GET' && form) return this.#uploadForm(aci, account, Number(form[1]));
        return chatJson(404, {});
      },
    };
  }

  #uploadForm(aci: string, account: Account, count: number): ChatResponse {
    if (count < 1 || count > 201) return chatJson(400, {});
    const { burst, intervalMs } = this.uploadLimit;
    const now = this.clock.now();
    account.uploadTokens = Math.min(burst, account.uploadTokens + (now - account.uploadTokensAt) / intervalMs);
    account.uploadTokensAt = now;
    if (account.uploadTokens < 1) {
      const retryAfter = Math.ceil(((1 - account.uploadTokens) * intervalMs) / 1000);
      return {
        status: 429,
        message: 'Too Many Requests',
        headers: [`Retry-After:${retryAfter}`],
        body: new Uint8Array(0),
      };
    }
    account.uploadTokens -= 1;
    this.formsIssued.set(aci, (this.formsIssued.get(aci) ?? 0) + 1);
    const packId = hex(this.#random(16));
    const item = (id: number, key: string, maxBytes: number) => {
      this.#policies.set(key, { expires: now + POLICY_LIFETIME_MS, maxBytes, account: aci });
      const policy = btoa(JSON.stringify({ key, maxBytes }));
      return {
        id,
        key,
        credential: 'simulated',
        acl: 'private',
        algorithm: 'AWS4-HMAC-SHA256',
        date: '20261109T120000Z',
        policy,
        signature: 'simulated',
      };
    };
    return chatJson(200, {
      packId,
      manifest: item(-1, `stickers/${packId}/manifest.proto`, MAX_ENCRYPTED_MANIFEST),
      stickers: Array.from({ length: count }, (_, i) => item(i, `stickers/${packId}/full/${i}`, MAX_ENCRYPTED_STICKER)),
    });
  }

  /** HTTPS to the storage service and the CDN. */
  readonly https: HttpsRequest = async (host, method, path, headers = [], body = new Uint8Array(0)) => {
    this.#checkFaults(`https ${method} ${host} ${path}`);
    if (host === 'storage.signal.org') return this.#storage(method, path, headers, body);
    if (host === 'cdn.signal.org' && method === 'POST' && path === '/') return this.#cdnUpload(headers, body);
    return httpResponse(404);
  };

  #storageAccount(headers: string[]): Account | null {
    const authorization = headers.find((line) => line.toLowerCase().startsWith('authorization:'));
    const credentials = authorization ? atob(authorization.split(' ').pop()!) : '';
    for (const account of this.#accounts.values()) {
      if (credentials === `${account.storageLogin.username}:${account.storageLogin.password}`) return account;
    }
    return null;
  }

  async #storage(method: string, path: string, headers: string[], body: Uint8Array): Promise<HttpResponse> {
    const account = this.#storageAccount(headers);
    if (!account) return httpResponse(401);
    const storage = account.storage;
    const currentManifest = () =>
      toBinary(
        StorageManifestSchema,
        create(StorageManifestSchema, { version: storage.version, value: storage.manifest! }),
      );
    if (method === 'GET' && path === '/v1/storage/manifest') {
      return storage.manifest ? httpResponse(200, currentManifest()) : httpResponse(404);
    }
    if (method === 'PUT' && path === '/v1/storage/read') {
      const { readKey } = fromBinary(ReadOperationSchema, body);
      const items = readKey.flatMap((key) => {
        const value = storage.items.get(hex(key));
        return value ? [create(StorageItemSchema, { key, value })] : [];
      });
      return httpResponse(200, toBinary(StorageItemsSchema, create(StorageItemsSchema, { items })));
    }
    if (method === 'PUT' && path === '/v1/storage/') {
      for (const change of this.#beforeStorageWrite.splice(0)) await change();
      const operation = fromBinary(WriteOperationSchema, body);
      if (!operation.manifest || operation.manifest.version !== storage.version + 1n)
        return httpResponse(409, currentManifest());
      for (const key of operation.deleteKey) {
        if (!storage.items.has(hex(key))) return httpResponse(400);
      }
      for (const item of operation.insertItem) {
        if (storage.items.has(hex(item.key))) return httpResponse(400);
      }
      for (const key of operation.deleteKey) storage.items.delete(hex(key));
      for (const item of operation.insertItem) storage.items.set(hex(item.key), item.value);
      storage.version = operation.manifest.version;
      storage.manifest = operation.manifest.value;
      this.storageWrites++;
      return httpResponse(200);
    }
    return httpResponse(404);
  }

  /** Puts an account's storage in place directly, as registration and earlier use of Signal would have. */
  seedStorage(
    aci: string,
    version: bigint,
    manifest: Uint8Array,
    items: { key: Uint8Array; value: Uint8Array }[],
  ): void {
    const storage = this.#account(aci).storage;
    storage.version = version;
    storage.manifest = manifest;
    storage.items = new Map(items.map((item) => [hex(item.key), item.value]));
  }

  /** The stored storage items of an account, by hex record ID. */
  storageItems(aci: string): Map<string, Uint8Array> {
    return new Map(this.#account(aci).storage.items);
  }

  #cdnUpload(headers: string[], body: Uint8Array): HttpResponse {
    const contentType =
      headers
        .find((line) => line.toLowerCase().startsWith('content-type:'))
        ?.slice('content-type:'.length)
        .trim() ?? '';
    const parts = parseMultipart(body, contentType);
    const key = new TextDecoder().decode(parts.get('key'));
    const file = parts.get('file');
    const policy = this.#policies.get(key);
    if (!policy || !file || policy.expires < this.clock.now() || file.length > policy.maxBytes || file.length === 0)
      return httpResponse(403);
    if (this.#cdn.has(key)) return httpResponse(403);
    this.#cdn.set(key, file);
    if (key.endsWith('/manifest.proto'))
      this.packsUploaded.set(policy.account, (this.packsUploaded.get(policy.account) ?? 0) + 1);
    return httpResponse(204);
  }

  /** A file on the CDN, by key (stickers/<pack ID>/manifest.proto or stickers/<pack ID>/full/<n>). */
  cdnFile(key: string): Uint8Array | null {
    return this.#cdn.get(key) ?? null;
  }

  /** The manifest of a pack, as the page reads it from Signal's public CDN to verify an index entry. */
  readonly manifestSource = async (packId: Uint8Array): Promise<Uint8Array | null> =>
    this.cdnFile(`stickers/${hex(packId)}/manifest.proto`);
}
