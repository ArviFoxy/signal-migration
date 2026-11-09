// Links a temporary device to the user's Signal account from this page, logs in with it, and unlinks it.
//
// Secrets (the provisioning message, identity keys, the device password) live only in local variables of
// `runLinkCycle`. They are never passed to `report`, the console, or any request except the ones Signal needs.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import QRCode from 'qrcode';
import { ProvisioningAddressSchema } from './gen/chat_provisioning_pb';
import { ProvisionMessageSchema } from './gen/DeviceMessages_pb';
import { DeviceNameSchema } from './gen/DeviceName_pb';
import { SignalSocket } from './signal-socket';
import init, {
  encryptDeviceName,
  generateKyberLastResortPreKey,
  generateSignedPreKey,
  ProvisioningReceiver,
} from './wasm/signal_migration_wasm';

/** Anonymous sockets (linking) use one reflector and the logged-in socket the other. The browser caches the
 * device's login per host, so keeping them apart stops a later run from sending a dead login on an anonymous socket. */
const LINK_REFLECTOR = 'reflector-signal.global.ssl.fastly.net';
const AUTH_REFLECTOR = 'reflector-nrgwuv7kwq-uc.a.run.app';
const DEVICE_NAME = 'Sticker migration test';
const PROVISIONING_TIMEOUT_MS = 180_000;

export type LinkCycleCallbacks = {
  report: (line: string) => void;
  showQrCode: (dataUrl: string | null) => void;
};

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const randomHex = (byteCount: number) => Array.from(crypto.getRandomValues(new Uint8Array(byteCount)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomInt = (min: number, max: number) => min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));
const jsonBody = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parseJson = <T>(bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as T;

/** Waits for the primary device to scan the QR code and returns the decrypted ProvisionMessage. */
async function receiveProvisionMessage(callbacks: LinkCycleCallbacks) {
  const receiver = new ProvisioningReceiver();
  const socket = await SignalSocket.open(`wss://${LINK_REFLECTOR}/service/v1/websocket/provisioning/`, '/v1/keepalive/provisioning');
  try {
    const envelope = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no scan within 3 minutes')), PROVISIONING_TIMEOUT_MS);
      socket.onUnexpectedClose = (code) => {
        clearTimeout(timer);
        callbacks.showQrCode(null);
        reject(new Error(`the linking socket was closed (code ${code}) before a scan arrived; press Run again`));
      };
      socket.onServerRequest = (request) => {
        if (request.path === '/v1/address') {
          const address = fromBinary(ProvisioningAddressSchema, request.body).address;
          const url = new URL('sgnl://linkdevice');
          url.search = new URLSearchParams({ uuid: address, pub_key: base64(receiver.publicKey()), capabilities: 'nopni,nopni2' }).toString();
          void QRCode.toDataURL(url.toString(), { margin: 2, width: 280 }).then(callbacks.showQrCode);
          callbacks.report('link: QR code shown; scan it in Signal under Settings › Linked devices');
        } else if (request.path === '/v1/message') {
          clearTimeout(timer);
          resolve(request.body);
        }
        return 200;
      };
    });
    callbacks.showQrCode(null);
    return fromBinary(ProvisionMessageSchema, receiver.decryptEnvelope(envelope));
  } finally {
    socket.close();
    receiver.free();
  }
}

export async function runLinkCycle(callbacks: LinkCycleCallbacks): Promise<void> {
  const { report } = callbacks;
  await init({ module_or_path: '/signal_migration_wasm_bg.wasm' });

  const provision = await receiveProvisionMessage(callbacks);
  report('link: provisioning message received and decrypted');

  const hasPni = provision.pniIdentityKeyPrivate.length > 0 && provision.pni !== '';
  const password = randomHex(16);
  const preKey = (generate: typeof generateSignedPreKey, identityPrivate: Uint8Array) => {
    const key = generate(identityPrivate, randomInt(1, 0xffffff));
    const serialized = { keyId: key.keyId, publicKey: base64(key.publicKey), signature: base64(key.signature) };
    key.free();
    return serialized;
  };
  const name = encryptDeviceName(DEVICE_NAME, provision.aciIdentityKeyPublic);
  const deviceName = toBinary(DeviceNameSchema, create(DeviceNameSchema, { ephemeralPublic: name.ephemeralPublic, syntheticIv: name.syntheticIv, ciphertext: name.ciphertext }));
  name.free();

  const linkRequest = {
    verificationCode: provision.provisioningCode,
    accountAttributes: {
      fetchesMessages: true,
      name: base64(deviceName),
      registrationId: randomInt(1, 16380),
      pniRegistrationId: hasPni ? randomInt(1, 16380) : undefined,
      capabilities: { attachmentBackfill: false, spqr: true, usernameChangeSyncMessage: true, optionalPhoneNumber: !hasPni },
    },
    aciSignedPreKey: preKey(generateSignedPreKey, provision.aciIdentityKeyPrivate),
    aciPqLastResortPreKey: preKey(generateKyberLastResortPreKey, provision.aciIdentityKeyPrivate),
    pniSignedPreKey: hasPni ? preKey(generateSignedPreKey, provision.pniIdentityKeyPrivate) : undefined,
    pniPqLastResortPreKey: hasPni ? preKey(generateKyberLastResortPreKey, provision.pniIdentityKeyPrivate) : undefined,
  };

  const anonymous = await SignalSocket.open(`wss://${LINK_REFLECTOR}/service/v1/websocket/`, '/v1/keepalive');
  const linkResponse = await anonymous.request('PUT', '/v1/devices/link', {
    headers: ['content-type:application/json', `authorization:Basic ${btoa(`${provision.aci}:${password}`)}`],
    body: jsonBody(linkRequest),
  });
  anonymous.close();
  for (const secret of [provision.aciIdentityKeyPrivate, provision.pniIdentityKeyPrivate, provision.masterKey, provision.profileKey, provision.mediaRootBackupKey, provision.ephemeralBackupKey]) {
    secret.fill(0);
  }
  if (linkResponse.status !== 200) {
    report(`link: FAILED, server answered ${linkResponse.status} ${linkResponse.message}`);
    return;
  }
  const { deviceId } = parseJson<{ deviceId: number }>(linkResponse.body);
  report(`link: OK, linked as device ${deviceId}`);

  let unlinked = false;
  try {
    // The browser sends URL credentials only after a 401 challenge and then caches them for this host;
    // /v1/devices challenges, so this request primes the cache for the logged-in socket below.
    await new Promise<void>((resolve) => {
      const priming = new WebSocket(`wss://${provision.aci}.${deviceId}:${password}@${AUTH_REFLECTOR}/service/v1/devices`);
      priming.onopen = priming.onerror = priming.onclose = () => resolve();
    });

    const session = await SignalSocket.open(`wss://${AUTH_REFLECTOR}/service/v1/websocket/`, '/v1/keepalive');
    try {
      const devices = await session.request('GET', '/v1/devices');
      if (devices.status !== 200) {
        report(`login: FAILED, GET /v1/devices answered ${devices.status}`);
        return;
      }
      const list = parseJson<{ devices: { id: number }[] }>(devices.body).devices;
      report(`login: OK, the account has ${list.length} devices, including this one: ${list.some((d) => d.id === deviceId)}`);

      const removal = await session.request('DELETE', `/v1/devices/${deviceId}`);
      unlinked = removal.status === 200 || removal.status === 204;
      report(unlinked ? 'unlink: OK, device removed' : `unlink: FAILED, server answered ${removal.status}`);
    } finally {
      session.close();
    }
  } finally {
    if (!unlinked) report(`unlink: device ${deviceId} is still linked; remove it in Signal under Settings › Linked devices`);
  }
}
