// Links a temporary device to the user's Signal account: shows the QR code, receives and decrypts the
// provisioning message from the user's phone, and registers the device.
//
// The returned LinkedAccount holds secrets in memory only. Nothing here logs or stores them.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { ProvisioningAddressSchema } from '../gen/chat_provisioning_pb';
import { type ProvisionMessage, ProvisionMessageSchema } from '../gen/DeviceMessages_pb';
import { DeviceNameSchema } from '../gen/DeviceName_pb';
import {
  encryptDeviceName,
  generateKyberLastResortPreKey,
  generateSignedPreKey,
  ProvisioningReceiver,
  storageServiceKeyFromAccountEntropyPool,
  storageServiceKeyFromMasterKey,
} from '../wasm/signal_migration_wasm';
import { basicAuthorization, type DeviceCredentials } from './session';
import { connectChat } from './socket';
import { loadSignalWasm } from './wasm';

/** The linked device's name, as the user sees it in Signal's list of linked devices, unless they choose another. */
export const DEFAULT_DEVICE_NAME = 'Sticker migration';
const SCAN_TIMEOUT_MS = 180_000;

/** What the migration keeps from linking, in memory only, until it unlinks. */
export type LinkedAccount = {
  credentials: DeviceCredentials;
  /**
   * Decrypts the account's storage service records (installed sticker packs and their order). Derived from the
   * account's keys in the linking message, which are discarded right after linking: the migration needs nothing else
   * they protect.
   */
  storageServiceKey: Uint8Array;
  /**
   * What the device needs to send messages to the account's other devices (signal/own-devices.ts): the account's
   * identity key pair, which every device of the account shares, and this device's registration ID.
   */
  identity?: { publicKey: Uint8Array; privateKey: Uint8Array };
  registrationId?: number;
};

/**
 * The storage service key from the linking message. Current phones send the account entropy pool and no master key
 * (Signal-Android LinkDeviceApi.kt); older ones sent only the master key.
 */
export function storageServiceKeyOf(provision: Pick<ProvisionMessage, 'accountEntropyPool' | 'masterKey'>): Uint8Array {
  if (provision.accountEntropyPool) return storageServiceKeyFromAccountEntropyPool(provision.accountEntropyPool);
  if (provision.masterKey.length > 0) return storageServiceKeyFromMasterKey(provision.masterKey);
  throw new Error('the phone sent no account key, so the sticker packs in your Signal account cannot be read');
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const randomHex = (byteCount: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(byteCount)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomInt = (min: number, max: number) => min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));

/** Reports progress events that contain no secrets (request paths, close codes). */
export type LinkEvents = (event: string) => void;

/** The error linking fails with when it was cancelled. */
export class LinkingCancelledError extends Error {
  constructor() {
    super('linking was cancelled');
  }
}

/** Waits for the phone to scan the QR code (passed to `showQrCode` as a `sgnl://linkdevice` URL). */
async function receiveProvisionMessage(
  showQrCode: (url: string) => void,
  onEvent: LinkEvents,
  cancel: AbortSignal,
): Promise<ProvisionMessage> {
  await loadSignalWasm();
  cancel.throwIfAborted();
  const receiver = new ProvisioningReceiver();
  const socket = await connectChat('/v1/websocket/provisioning/', '/v1/keepalive/provisioning');
  onEvent('linking socket open');
  try {
    const envelope = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the QR code was not scanned within 3 minutes')),
        SCAN_TIMEOUT_MS,
      );
      const onCancel = () => {
        clearTimeout(timer);
        reject(new LinkingCancelledError());
      };
      if (cancel.aborted) onCancel();
      cancel.addEventListener('abort', onCancel, { once: true });
      socket.onUnexpectedClose = (code) => {
        clearTimeout(timer);
        onEvent(`linking socket closed, code ${code}`);
        reject(new Error(`the connection to Signal closed (code ${code}) before the QR code was scanned`));
      };
      socket.onServerRequest = (request) => {
        onEvent(`linking socket: Signal sent ${request.verb} ${request.path}`);
        if (request.path === '/v1/address') {
          const address = fromBinary(ProvisioningAddressSchema, request.body).address;
          const url = new URL('sgnl://linkdevice');
          url.search = new URLSearchParams({
            uuid: address,
            pub_key: base64(receiver.publicKey()),
            capabilities: 'nopni,nopni2',
          }).toString();
          showQrCode(url.toString());
        } else if (request.path === '/v1/message') {
          clearTimeout(timer);
          resolve(request.body);
        }
        return 200;
      };
    });
    return fromBinary(ProvisionMessageSchema, receiver.decryptEnvelope(envelope));
  } finally {
    socket.close();
    receiver.free();
  }
}

function signedKey(generate: typeof generateSignedPreKey, identityPrivate: Uint8Array) {
  const key = generate(identityPrivate, randomInt(1, 0xffffff));
  const serialized = { keyId: key.keyId, publicKey: base64(key.publicKey), signature: base64(key.signature) };
  key.free();
  return serialized;
}

/**
 * Links the device and returns its login and the keys the migration needs. `deviceName` is read when the phone has
 * scanned the code, so the user can still change it while the code shows. `cancel` stops waiting for the scan.
 */
export async function linkDevice(
  showQrCode: (url: string) => void,
  onEvent: LinkEvents = () => undefined,
  deviceName: () => string = () => DEFAULT_DEVICE_NAME,
  cancel: AbortSignal = new AbortController().signal,
): Promise<LinkedAccount> {
  const provision = await receiveProvisionMessage(showQrCode, onEvent, cancel);
  onEvent('linking message decrypted');
  try {
    // Everything that can fail on the message's content is done before Signal registers the device.
    const storageServiceKey = storageServiceKeyOf(provision);
    const hasPni = provision.pniIdentityKeyPrivate.length > 0 && provision.pni !== '';
    const password = randomHex(16);
    const registrationId = randomInt(1, 16380);
    const name = encryptDeviceName(deviceName().trim() || DEFAULT_DEVICE_NAME, provision.aciIdentityKeyPublic);
    const encryptedName = toBinary(
      DeviceNameSchema,
      create(DeviceNameSchema, {
        ephemeralPublic: name.ephemeralPublic,
        syntheticIv: name.syntheticIv,
        ciphertext: name.ciphertext,
      }),
    );
    name.free();

    const linkRequest = {
      verificationCode: provision.provisioningCode,
      accountAttributes: {
        fetchesMessages: true,
        name: base64(encryptedName),
        registrationId,
        pniRegistrationId: hasPni ? randomInt(1, 16380) : undefined,
        capabilities: {
          attachmentBackfill: false,
          spqr: true,
          usernameChangeSyncMessage: true,
          optionalPhoneNumber: !hasPni,
        },
      },
      aciSignedPreKey: signedKey(generateSignedPreKey, provision.aciIdentityKeyPrivate),
      aciPqLastResortPreKey: signedKey(generateKyberLastResortPreKey, provision.aciIdentityKeyPrivate),
      pniSignedPreKey: hasPni ? signedKey(generateSignedPreKey, provision.pniIdentityKeyPrivate) : undefined,
      pniPqLastResortPreKey: hasPni
        ? signedKey(generateKyberLastResortPreKey, provision.pniIdentityKeyPrivate)
        : undefined,
    };

    cancel.throwIfAborted();
    const socket = await connectChat('/v1/websocket/', '/v1/keepalive');
    try {
      const response = await socket.request('PUT', '/v1/devices/link', {
        headers: ['content-type:application/json', basicAuthorization(provision.aci, password).replace(': ', ':')],
        body: new TextEncoder().encode(JSON.stringify(linkRequest)),
      });
      if (response.status !== 200) throw new Error(`linking was refused: ${response.status} ${response.message}`);
      const { deviceId } = JSON.parse(new TextDecoder().decode(response.body)) as { deviceId: number };
      return {
        credentials: { aci: provision.aci, deviceId, password },
        identity: {
          publicKey: provision.aciIdentityKeyPublic.slice(),
          privateKey: provision.aciIdentityKeyPrivate.slice(),
        },
        registrationId,
        storageServiceKey,
      };
    } finally {
      socket.close();
    }
  } finally {
    for (const secret of [
      provision.aciIdentityKeyPrivate,
      provision.pniIdentityKeyPrivate,
      provision.masterKey,
      provision.profileKey,
      provision.mediaRootBackupKey,
      provision.ephemeralBackupKey,
    ]) {
      secret.fill(0);
    }
  }
}
