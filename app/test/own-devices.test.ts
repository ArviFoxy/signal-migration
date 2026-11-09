// Sending sync messages to the account's other devices (signal/own-devices.ts) against a simulated server. The
// prekey bundles are real: an identity key from WebCrypto's X25519, and prekeys signed with it by libsignal, so that
// libsignal verifies them when it starts each session. The expected request format is Signal-Server's
// (entities/IncomingMessageList.java, IncomingMessage.java, PreKeyResponse.java, controllers/KeysController.java,
// MessageController.java).

import { fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  ContentSchema,
  SyncMessage_FetchLatest_Type,
  SyncMessage_StickerPackOperation_Type,
} from '../src/gen/SignalService_pb';
import {
  fetchLatestStorageMessage,
  installStickerPacksMessage,
  OwnDevices,
  padMessageBody,
} from '../src/signal/own-devices';
import type { ChatChannel, ChatResponse } from '../src/signal/transport';
import { generateKyberLastResortPreKey, generateSignedPreKey } from '../src/wasm/signal_migration_wasm';
import './wasm';

const ACI = 'simulated-account';
const OUR_DEVICE = 3;
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** An X25519 key pair in libsignal's forms: the public key with its type byte 0x05, the private scalar. */
async function keyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKey: new Uint8Array([0x05, ...publicRaw]), privateKey: pkcs8.slice(-32) };
}

/** The account: one identity key for all its devices, and each device's published prekeys. */
async function account(deviceIds: number[]) {
  const identity = await keyPair();
  const device = async (deviceId: number) => {
    const signed = generateSignedPreKey(identity.privateKey, 100 + deviceId);
    const kyber = generateKyberLastResortPreKey(identity.privateKey, 200 + deviceId);
    const oneTime = await keyPair();
    const item = {
      deviceId,
      registrationId: 1000 + deviceId,
      signedPreKey: { keyId: signed.keyId, publicKey: base64(signed.publicKey), signature: base64(signed.signature) },
      preKey: { keyId: 300 + deviceId, publicKey: base64(oneTime.publicKey) },
      pqPreKey: { keyId: kyber.keyId, publicKey: base64(kyber.publicKey), signature: base64(kyber.signature) },
    };
    signed.free();
    kyber.free();
    return item;
  };
  const devices = new Map(await Promise.all(deviceIds.map(async (id) => [id, await device(id)] as const)));
  return { identity, devices };
}

type Sent = {
  messages: { type: number; destinationDeviceId: number; destinationRegistrationId: number; content: string }[];
};

/**
 * A chat connection to a simulated server; `answers` gives the status and body of each message list in turn, and
 * `listed` the devices the server knows when the sender first asks for all of them.
 */
function server(
  accountData: Awaited<ReturnType<typeof account>>,
  answers: { status: number; body?: object }[],
  listed = [...accountData.devices.keys()],
) {
  const requests: { verb: string; path: string; body?: unknown }[] = [];
  const answer = (status: number, body: object = {}): ChatResponse => ({
    status,
    message: '',
    headers: [],
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
  const chat: ChatChannel = {
    async request(verb, path, options) {
      const body = options?.body ? JSON.parse(new TextDecoder().decode(options.body)) : undefined;
      requests.push({ verb, path, body });
      const keys = /^\/v2\/keys\/([^/]+)\/(\*|\d+)$/.exec(path);
      if (verb === 'GET' && keys?.[1] === ACI) {
        const wanted = keys[2] === '*' ? listed : [Number(keys[2])];
        return answer(200, {
          identityKey: base64(accountData.identity.publicKey),
          devices: wanted.map((id) => accountData.devices.get(id)!),
        });
      }
      if (verb === 'PUT' && path === `/v1/messages/${ACI}`) {
        const next = answers.shift() ?? { status: 200 };
        return answer(next.status, next.body);
      }
      return answer(404);
    },
  };
  const sent = () => requests.filter((r) => r.verb === 'PUT').map((r) => r.body as Sent);
  return { chat, requests, sent };
}

const sender = (data: Awaited<ReturnType<typeof account>>) =>
  new OwnDevices({ aci: ACI, deviceId: OUR_DEVICE, registrationId: 1003, identity: data.identity });
const devicesOf = (list: Sent) => list.messages.map((m) => m.destinationDeviceId).sort();

describe('messages to the account’s other devices', () => {
  // Detects: requests the server does not accept: wrong paths or field names, the sending device included, a wrong
  // registration ID, or a first message that does not start the session (envelope type 3, PREKEY_BUNDLE).
  it('starts sessions from the prekey bundles and sends in the server’s message format', async () => {
    const data = await account([1, 2, OUR_DEVICE]);
    const { chat, requests, sent } = server(data, []);
    await sender(data).send(chat, new Uint8Array([1, 2, 3]));
    expect(requests[0]).toMatchObject({ verb: 'GET', path: `/v2/keys/${ACI}/*` });
    const [list] = sent();
    expect(devicesOf(list)).toEqual([1, 2]);
    for (const message of list.messages) {
      expect(message.type).toBe(3);
      expect(message.destinationRegistrationId).toBe(1000 + message.destinationDeviceId);
      expect(message.content.length).toBeGreaterThan(0);
    }
    expect(list).toMatchObject({ online: false, urgent: true, timestamp: expect.any(Number) });
  });

  // Detects: a message list the server refused (409) because the account gained or lost a device, sent again
  // unchanged, so that the new device never hears of the packs.
  it('adds a device the server says is missing and drops one it says is gone', async () => {
    const data = await account([1, 2, 4]);
    const { chat, sent } = server(data, [{ status: 409, body: { missingDevices: [4], extraDevices: [2] } }], [1, 2]);
    await sender(data).send(chat, new Uint8Array([1]));
    const lists = sent();
    expect(lists).toHaveLength(2);
    expect(devicesOf(lists[1])).toEqual([1, 4]);
  });

  // Detects: a device that reinstalled Signal (410, stale session) getting messages in the old session, which it
  // can no longer decrypt.
  it('starts a new session with a device whose session is stale', async () => {
    const data = await account([1, 2]);
    const { chat, requests, sent } = server(data, [{ status: 410, body: { staleDevices: [1] } }]);
    await sender(data).send(chat, new Uint8Array([1]));
    expect(requests.some((r) => r.verb === 'GET' && r.path === `/v2/keys/${ACI}/1`)).toBe(true);
    expect(sent()[1].messages.find((m) => m.destinationDeviceId === 1)?.type).toBe(3);
  });
});

describe('the identity of the account’s other devices', () => {
  // Detects: a session started with whatever identity key the server names, so that a server that swaps the key
  // receives the sync messages (with the packs' keys) instead of the user's devices.
  it('sends nothing when the bundles carry an identity key other than the account’s', async () => {
    const data = await account([1, 2]);
    // The server answers with bundles of its own, consistently signed with its own identity key.
    const { chat, sent } = server(await account([1, 2]), []);
    await expect(sender(data).send(chat, new Uint8Array([1]))).rejects.toThrow(/identity key/);
    expect(sent()).toHaveLength(0);
  });
});

describe('sync messages', () => {
  // Detects: the install operations and "fetch latest" sent in one message: Android handles only the first kind it
  // finds in a sync message (SyncMessageProcessor.kt), so the storage, with the packs' order, would not be read.
  it('installs packs and asks for the storage in two separate messages', () => {
    const install = fromBinary(
      ContentSchema,
      installStickerPacksMessage([{ packId: new Uint8Array(16).fill(1), packKey: new Uint8Array(32).fill(2) }]),
    );
    const fetch = fromBinary(ContentSchema, fetchLatestStorageMessage());
    expect(install.content.case).toBe('syncMessage');
    expect(fetch.content.case).toBe('syncMessage');
    const installSync = install.content.value as {
      stickerPackOperation: { type: number; packId: Uint8Array; packKey: Uint8Array }[];
      content: { case?: string };
    };
    const fetchSync = fetch.content.value as {
      stickerPackOperation: unknown[];
      content: { case?: string; value?: { type: number } };
    };
    expect(installSync.stickerPackOperation).toMatchObject([
      {
        type: SyncMessage_StickerPackOperation_Type.INSTALL,
        packId: new Uint8Array(16).fill(1),
        packKey: new Uint8Array(32).fill(2),
      },
    ]);
    expect(installSync.content.case).toBeUndefined();
    expect(fetchSync.stickerPackOperation).toEqual([]);
    expect(fetchSync.content).toMatchObject({
      case: 'fetchLatest',
      value: { type: SyncMessage_FetchLatest_Type.STORAGE_MANIFEST },
    });
  });

  // Detects: padding that receivers strip to something else than the message. Expected lengths from
  // Signal-Android PushTransportDetails.getPaddedMessageBody (blocks of 80 bytes, a 0x80 byte after the content).
  it('pads the body as Signal’s clients do', () => {
    for (const [length, padded] of [
      [0, 79],
      [78, 79],
      [79, 159],
      [200, 239],
    ]) {
      const body = new Uint8Array(length).fill(7);
      const result = padMessageBody(body);
      expect(result.length).toBe(padded);
      expect(result[length]).toBe(0x80);
      expect(result.slice(length + 1).every((byte) => byte === 0)).toBe(true);
    }
  });
});
