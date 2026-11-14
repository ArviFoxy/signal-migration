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
import { randomBytes, randomInt } from '../core/random';
import { OwnDeviceSessions } from '../wasm/signal_migration_wasm';
import type { ChatChannel } from './transport';

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
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
const syncPadding = () => randomBytes(randomInt(1, 64));

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

/** Sends messages to the account's other devices, keeping the sessions with them for as long as it lives. */
export class OwnDevices {
  #sessions: OwnDeviceSessions;
  /** The other devices with a session. */
  #devices = new Set<number>();
  #bundlesRead = false;

  constructor(private readonly sender: SenderIdentity) {
    this.#sessions = new OwnDeviceSessions(
      sender.identity.publicKey,
      sender.identity.privateKey,
      sender.registrationId,
      sender.aci,
      sender.deviceId,
    );
  }

  /** Starts sessions from the prekey bundles of the account's devices: all of them (`*`), or one. */
  async #startSessions(chat: ChatChannel, devices: '*' | number): Promise<void> {
    const response = await chat.request('GET', `/v2/keys/${this.sender.aci}/${devices}`);
    if (response.status === 404) return;
    if (response.status !== 200) throw new Error(`reading the keys of your other devices answered ${response.status}`);
    const bundle = parse<PreKeyResponse>(response.body);
    // Every device of the account shares the account's identity key. A bundle with another key would start a
    // session with someone else, who could then read the packs' keys in the messages.
    const identityKey = fromBase64(bundle.identityKey);
    const own = this.sender.identity.publicKey;
    if (identityKey.length !== own.length || identityKey.some((byte, i) => byte !== own[i]))
      throw new Error("Signal answered with an identity key that is not this account's for your other devices");
    for (const device of bundle.devices) {
      if (device.deviceId === this.sender.deviceId) continue;
      const { signedPreKey, pqPreKey, preKey } = device;
      this.#sessions.startSession(
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

  /** Sends one message (a serialized Content) to every other device of the account. */
  async send(chat: ChatChannel, content: Uint8Array): Promise<void> {
    if (!this.#bundlesRead) {
      await this.#startSessions(chat, '*');
      this.#bundlesRead = true;
    }
    const padded = padMessageBody(content);
    for (let attempt = 0; attempt < 4; attempt++) {
      const messages = [...this.#devices].map((deviceId) => {
        const encrypted = this.#sessions.encrypt(deviceId, padded);
        const message = {
          type: encrypted.envelopeType,
          destinationDeviceId: deviceId,
          destinationRegistrationId: encrypted.registrationId,
          content: toBase64(encrypted.body),
        };
        encrypted.free();
        return message;
      });
      const response = await chat.request('PUT', `/v1/messages/${this.sender.aci}`, {
        headers: ['content-type:application/json'],
        body: json({ messages, online: false, urgent: true, timestamp: Date.now() }),
      });
      if (response.status === 200) return;
      if (response.status === 409) {
        const { missingDevices = [], extraDevices = [] } = parse<{
          missingDevices?: number[];
          extraDevices?: number[];
        }>(response.body);
        for (const deviceId of extraDevices) this.#devices.delete(deviceId);
        for (const deviceId of missingDevices) await this.#startSessions(chat, deviceId);
      } else if (response.status === 410) {
        const { staleDevices = [] } = parse<{ staleDevices?: number[] }>(response.body);
        for (const deviceId of staleDevices) {
          this.#devices.delete(deviceId);
          await this.#startSessions(chat, deviceId);
        }
      } else {
        throw new Error(`sending to your other devices answered ${response.status}`);
      }
    }
    throw new Error('your devices changed while the message was being sent; try again');
  }
}
