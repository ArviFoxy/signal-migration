// Messages from the linked device to the account's other devices: the phone and any other linked device. Signal's
// clients learn about sticker packs installed elsewhere only from such messages ("sync messages"): iOS installs packs
// only from a sticker pack operation, and Android reads the storage service again on "fetch latest".
//
// The server hands out each device's prekey bundle (GET /v2/keys); libsignal (OwnDeviceSessions in our WebAssembly
// module) starts a session from it and encrypts each message. The server refuses a message list that does not name
// exactly the account's other devices (409) or that uses a session a device no longer has (410); the list is
// corrected and sent again.

import { create, toBinary } from '@bufbuild/protobuf';
import {
  ContentSchema,
  SyncMessage_FetchLatest_Type,
  SyncMessage_StickerPackOperation_Type,
} from '../gen/SignalService_pb';
import { fromBase64, sameBytes, toBase64 } from '../core/bytes';
import { randomBytes } from '../core/random';
import { OwnDeviceSessions, randomInt } from '../wasm/signal_migration_wasm';
import { type ChatChannel, chatHeader, type ChatResponse } from './transport';

/** Either a direct chat channel or a session-reconnecting `withChat` wrapper so retries survive idle socket closes. */
export type ChatTarget = ChatChannel | (<T>(action: (chat: ChatChannel) => Promise<T>) => Promise<T>);

function requestOn(
  target: ChatTarget,
  verb: string,
  path: string,
  options?: { body?: Uint8Array; headers?: string[] },
): Promise<ChatResponse> {
  return typeof target === 'function'
    ? target((chat) => chat.request(verb, path, options))
    : target.request(verb, path, options);
}

function raceAbort<T>(promise: Promise<T>, cancel?: AbortSignal): Promise<T> {
  if (!cancel) return promise;
  if (cancel.aborted) return Promise.reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
    cancel.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cancel.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        cancel.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const MAX_RATE_LIMIT_RETRIES = 8;
const MAX_BACKOFF_WAIT_S = 60;
const MAX_RETRY_AFTER_S = 3600;

function retryWaitMs(headerValue: string | undefined, attempt: number): number {
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, MAX_RETRY_AFTER_S) * 1000 + 200;
  return Math.min(2 ** attempt, MAX_BACKOFF_WAIT_S) * 1000;
}

function abortableWait(ms: number, cancel?: AbortSignal): Promise<void> {
  if (cancel?.aborted) return Promise.reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancel!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cancel?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    cancel?.addEventListener('abort', onAbort, { once: true });
  });
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parse = <T>(body: Uint8Array) => JSON.parse(new TextDecoder().decode(body)) as T;

/**
 * Signal's padding of a message body before encryption: a 0x80 byte after the content, then zeros, to one byte
 * short of a multiple of 80 (Signal-Android PushTransportDetails.getPaddedMessageBody).
 */
export function padMessageBody(body: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((body.length + 2) / 80) * 80 - 1);
  padded.set(body);
  padded[body.length] = 0x80;
  return padded;
}

/** Random padding inside a sync message, as Signal's clients add, so that its size says little about its content. */
export const syncPadding = () => randomBytes(randomInt(1, 64));

/** A sync message that installs sticker packs on the account's other devices. */
export function installStickerPacksMessage(packs: { packId: Uint8Array; packKey: Uint8Array }[]): Uint8Array {
  return toBinary(
    ContentSchema,
    create(ContentSchema, {
      content: {
        case: 'syncMessage',
        value: {
          stickerPackOperation: packs.map(({ packId, packKey }) => ({
            packId,
            packKey,
            type: SyncMessage_StickerPackOperation_Type.INSTALL,
          })),
          padding: syncPadding(),
        },
      },
    }),
  );
}

/** A sync message that makes the account's other devices read the storage service again (pack order). */
export function fetchLatestStorageMessage(): Uint8Array {
  return toBinary(
    ContentSchema,
    create(ContentSchema, {
      content: {
        case: 'syncMessage',
        value: {
          content: { case: 'fetchLatest', value: { type: SyncMessage_FetchLatest_Type.STORAGE_MANIFEST } },
          padding: syncPadding(),
        },
      },
    }),
  );
}

type Key = { keyId: number; publicKey: string };
type SignedKey = Key & { signature: string };
type PreKeyResponse = {
  identityKey: string;
  devices: {
    deviceId: number;
    registrationId: number;
    signedPreKey: SignedKey;
    preKey?: Key | null;
    pqPreKey: SignedKey;
  }[];
};

/** What the linked device sends with: the account's identity key pair, its registration ID, the ACI, its ID. */
export type SenderIdentity = {
  aci: string;
  deviceId: number;
  registrationId: number;
  identity: { publicKey: Uint8Array; privateKey: Uint8Array };
};

export type OwnDeviceSendOptions = {
  timestamp?: number;
  urgent?: boolean;
  cancel?: AbortSignal;
  onWait?: (until: number | null) => void;
};

/** Sends messages to the account's other devices, keeping the sessions with them for as long as it lives. */
export class OwnDevices {
  #sessions: OwnDeviceSessions | null;
  /** The other devices with a session. */
  #devices = new Set<number>();
  #bundlesRead = false;
  #sendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly sender: SenderIdentity) {
    this.#sessions = new OwnDeviceSessions(
      sender.identity.publicKey,
      sender.identity.privateKey,
      sender.registrationId,
      sender.aci,
      sender.deviceId,
    );
  }

  /** Frees the WebAssembly sessions and the copy of the account identity key they hold. */
  free(): void {
    this.#sessions?.free();
    this.#sessions = null;
    this.#devices.clear();
  }

  #activeSessions(): OwnDeviceSessions {
    if (!this.#sessions) throw new Error('the device sessions were already closed');
    return this.#sessions;
  }

  /** Starts sessions from the prekey bundles of the account's devices: all of them (`*`), or one. */
  async #startSessions(
    target: ChatTarget,
    devices: '*' | number,
    cancel?: AbortSignal,
    onWait?: (until: number | null) => void,
  ): Promise<void> {
    let response!: ChatResponse;
    for (let rateRetries = 0; ;) {
      cancel?.throwIfAborted();
      response = await requestOn(target, 'GET', `/v2/keys/${this.sender.aci}/${devices}`);
      if (response.status === 429 && rateRetries < MAX_RATE_LIMIT_RETRIES) {
        const waitMs = retryWaitMs(chatHeader(response.headers, 'Retry-After'), rateRetries++);
        onWait?.(Date.now() + waitMs);
        try {
          await abortableWait(waitMs, cancel);
        } finally {
          onWait?.(null);
        }
        continue;
      }
      break;
    }
    if (response.status === 404) return;
    if (response.status !== 200) throw new Error(`reading the keys of your other devices answered ${response.status}`);
    const bundle = parse<PreKeyResponse>(response.body);
    // Every device of the account shares the account's identity key. A bundle with another key would start a
    // session with someone else, who could then read the packs' keys in the messages.
    const identityKey = fromBase64(bundle.identityKey);
    if (!sameBytes(identityKey, this.sender.identity.publicKey))
      throw new Error("Signal answered with an identity key that is not this account's for your other devices");
    for (const device of bundle.devices) {
      if (device.deviceId === this.sender.deviceId) continue;
      const { signedPreKey, pqPreKey, preKey } = device;
      this.#activeSessions().startSession(
        device.deviceId,
        device.registrationId,
        identityKey,
        signedPreKey.keyId,
        fromBase64(signedPreKey.publicKey),
        fromBase64(signedPreKey.signature),
        pqPreKey.keyId,
        fromBase64(pqPreKey.publicKey),
        fromBase64(pqPreKey.signature),
        preKey?.keyId ?? null,
        preKey ? fromBase64(preKey.publicKey) : null,
      );
      this.#devices.add(device.deviceId);
    }
  }

  /**
   * Sends one message (a serialized Content) to every other device of the account. Calls are serialized so concurrent
   * migration kinds never race on prekey bundle fetches or 409/410 device-list recovery; waiting callers abort
   * immediately if `cancel` fires. `timestamp` is the message's timestamp in milliseconds; `urgent` asks Signal to
   * wake a sleeping phone for the message.
   */
  send(target: ChatTarget, content: Uint8Array, options: OwnDeviceSendOptions = {}): Promise<void> {
    const { cancel } = options;
    if (cancel?.aborted) {
      return Promise.reject(cancel.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    const prev = this.#sendQueue;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#sendQueue = prev.then(() => done);

    return (async () => {
      try {
        await raceAbort(prev, cancel);
      } catch (error) {
        release();
        throw error;
      }
      try {
        cancel?.throwIfAborted();
        await this.#sendSerialized(target, content, options);
      } finally {
        release();
      }
    })();
  }

  async #sendSerialized(
    target: ChatTarget,
    content: Uint8Array,
    { timestamp = Date.now(), urgent = true, cancel, onWait }: OwnDeviceSendOptions = {},
  ): Promise<void> {
    cancel?.throwIfAborted();
    if (!this.#bundlesRead) {
      await this.#startSessions(target, '*', cancel, onWait);
      this.#bundlesRead = true;
    }
    const padded = padMessageBody(content);
    let deviceRetries = 0;
    let rateRetries = 0;
    let encryptedBatch:
      | {
          type: number;
          destinationDeviceId: number;
          destinationRegistrationId: number;
          content: string;
        }[]
      | null = null;
    for (;;) {
      cancel?.throwIfAborted();
      if (!encryptedBatch) {
        encryptedBatch = [...this.#devices].map((deviceId) => {
          const encrypted = this.#activeSessions().encrypt(deviceId, padded);
          const message = {
            type: encrypted.envelopeType,
            destinationDeviceId: deviceId,
            destinationRegistrationId: encrypted.registrationId,
            content: toBase64(encrypted.body),
          };
          encrypted.free();
          return message;
        });
      }
      const response = await requestOn(target, 'PUT', `/v1/messages/${this.sender.aci}`, {
        headers: ['content-type:application/json'],
        body: json({ messages: encryptedBatch, online: false, urgent, timestamp }),
      });
      if (response.status === 200) return;
      if (response.status === 429 && rateRetries < MAX_RATE_LIMIT_RETRIES) {
        const waitMs = retryWaitMs(chatHeader(response.headers, 'Retry-After'), rateRetries++);
        onWait?.(Date.now() + waitMs);
        try {
          await abortableWait(waitMs, cancel);
        } finally {
          onWait?.(null);
        }
        continue;
      }
      if (response.status === 409 && deviceRetries < 3) {
        deviceRetries++;
        encryptedBatch = null;
        const { missingDevices = [], extraDevices = [] } = parse<{
          missingDevices?: number[];
          extraDevices?: number[];
        }>(response.body);
        for (const deviceId of extraDevices) this.#devices.delete(deviceId);
        for (const deviceId of missingDevices) await this.#startSessions(target, deviceId, cancel, onWait);
      } else if (response.status === 410 && deviceRetries < 3) {
        deviceRetries++;
        encryptedBatch = null;
        const { staleDevices = [] } = parse<{ staleDevices?: number[] }>(response.body);
        for (const deviceId of staleDevices) {
          this.#devices.delete(deviceId);
          await this.#startSessions(target, deviceId, cancel, onWait);
        }
      } else if (response.status === 409 || response.status === 410) {
        throw new Error('your devices changed while the message was being sent; try again');
      } else {
        throw new Error(`sending to your other devices answered ${response.status}`);
      }
    }
  }
}
