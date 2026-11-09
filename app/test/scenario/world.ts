// The scenario framework's shared core, for every migration kind: a world of simulated services (Signal, a clock),
// users with a Telegram account and a Signal account, each user's phone, and the temporary linked device of a visit.
// A migration kind adds its own data and services in its folder (stickers/ for sticker packs).
//
// Below the simulated network, the app's real code runs: the storage client with its key derivations and
// encryption, and whatever a kind uses on top of it.

import type { ManifestRecord } from '../../src/gen/SignalStorage_pb';
import { basicAuthorization } from '../../src/signal/session';
import { StorageClient } from '../../src/signal/storage';
import type { ChatChannel, SignalAccount } from '../../src/signal/transport';
import { storageServiceKeyFromMasterKey } from '../../src/wasm/signal_migration_wasm';
import '../wasm';
import { VirtualClock } from './clock';
import { FakeSignal, type UploadLimit } from './fake-signal';
import { FakeTelegram } from './fake-telegram';
import { contactRecord, initialStorage, type NewRecord, writeOperation } from './storage-builder';

/** The temporary linked device of one visit, over the simulated Signal service. */
export class SimulatedAccount implements SignalAccount {
  readonly https;
  readonly #chat: ChatChannel;

  constructor(
    readonly signal: FakeSignal,
    readonly aci: string,
    readonly deviceId: number,
    readonly storageServiceKey: Uint8Array,
  ) {
    this.https = signal.https;
    this.#chat = signal.chat(aci, deviceId);
  }

  get isLinked(): boolean {
    return this.signal.isLinked(this.aci, this.deviceId);
  }

  withChat<T>(action: (chat: ChatChannel) => Promise<T>): Promise<T> {
    return action(this.#chat);
  }

  storage(): Promise<StorageClient> {
    return StorageClient.open(this.#chat, this.storageServiceKey, this.deviceId, this.https);
  }
}

/** The user's primary device (device 1), which reads and changes the account as Signal on a phone does. */
export class Phone {
  readonly chat: ChatChannel;

  constructor(
    readonly world: World,
    readonly aci: string,
    readonly masterKey: Uint8Array,
  ) {
    this.chat = world.signal.chat(aci, 1);
  }

  storage(): Promise<StorageClient> {
    return StorageClient.open(this.chat, storageServiceKeyFromMasterKey(this.masterKey), 1, this.world.signal.https);
  }

  /** Writes a change on top of `manifest`: removes the `deleted` records and adds `added`. */
  async writeRecords(manifest: ManifestRecord, deleted: Uint8Array[], added: NewRecord[]): Promise<void> {
    const login = JSON.parse(new TextDecoder().decode((await this.chat.request('GET', '/v1/storage/auth')).body)) as {
      username: string;
      password: string;
    };
    const body = writeOperation(this.masterKey, manifest, deleted, added);
    const response = await this.world.signal.https(
      'storage.signal.org',
      'PUT',
      '/v1/storage/',
      [basicAuthorization(login.username, login.password)],
      body,
    );
    if (response.status !== 200) throw new Error(`the phone's storage write answered ${response.status}`);
  }

  /** Removes a linked device, as Settings › Linked devices does. */
  unlink(deviceId: number): void {
    this.world.signal.unlinkDevice(this.aci, deviceId);
  }
}

export type StorageOptions = {
  /** Whether the manifest has record key material (accounts since 2024) or uses the older key derivation. */
  recordIkm?: boolean;
  /** How many contact records the storage starts with. */
  contacts?: number;
};

export class User {
  readonly aci: string;
  readonly masterKey = crypto.getRandomValues(new Uint8Array(32));
  readonly telegram = new FakeTelegram();
  readonly phone: Phone;

  constructor(
    readonly world: World,
    storage: StorageOptions = {},
  ) {
    this.aci = world.signal.createAccount();
    this.phone = new Phone(world, this.aci, this.masterKey);
    const recordIkm = (storage.recordIkm ?? true) ? crypto.getRandomValues(new Uint8Array(32)) : new Uint8Array(0);
    const contacts = Array.from({ length: storage.contacts ?? 0 }, (_, i) => contactRecord(`Contact ${i + 1}`));
    const seeded = initialStorage(this.masterKey, recordIkm, contacts);
    world.signal.seedStorage(this.aci, seeded.version, seeded.manifest, seeded.items);
  }

  /** Links a new device, as scanning the page's QR code does. */
  linkDevice(): SimulatedAccount {
    const storageServiceKey = storageServiceKeyFromMasterKey(this.masterKey);
    return new SimulatedAccount(this.world.signal, this.aci, this.world.signal.linkDevice(this.aci), storageServiceKey);
  }
}

export class World {
  readonly clock = new VirtualClock();
  readonly signal: FakeSignal;

  constructor(options: { uploadLimit?: UploadLimit } = {}) {
    this.signal = new FakeSignal(this.clock, options.uploadLimit);
  }
}
