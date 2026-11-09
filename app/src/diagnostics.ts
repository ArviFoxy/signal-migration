// Live checks of the connection to Signal through this server's relay. They use no account.

import { fromBinary } from '@bufbuild/protobuf';
import QRCode from 'qrcode';
import { StickerPackSchema } from './gen/Stickers_pb';
import { httpsRequest } from './signal/http-client';
import { decryptStickerFile } from './wasm/signal_migration_wasm';
import { linkDevice } from './signal/link';
import { SignalSession } from './signal/session';
import { connectChat } from './signal/socket';

const output = document.getElementById('out') as HTMLPreElement;
const report = (line: string) => {
  output.textContent += line + '\n';
};

async function checkProvisioningSocket(): Promise<void> {
  const started = performance.now();
  const socket = await connectChat('/v1/websocket/provisioning/', '/v1/keepalive/provisioning');
  report(`tunnel + TLS + WebSocket to chat.signal.org: open after ${Math.round(performance.now() - started)} ms`);
  const firstRequest = await new Promise<string>((resolve) => {
    socket.onServerRequest = (request) => {
      resolve(`${request.verb} ${request.path}`);
      return 200;
    };
  });
  report(`first request from Signal: ${firstRequest}`);
  const keepalive = await socket.request('GET', '/v1/keepalive/provisioning');
  report(`keepalive answered: ${keepalive.status}`);
  socket.close();

  // Signal's public "Bandit the Cat" pack, over HTTPS inside the page's own TLS session to cdn.signal.org.
  const response = await httpsRequest('cdn.signal.org', 'GET', '/stickers/9acc9e8aba563d26a4994e69263e3b25/manifest.proto');
  const key = new Uint8Array('5a6dff3948c28efb9b7aaf93ecc375c69fc316e78077ed26867a14d10a0f6a12'.match(/../g)!.map((h) => parseInt(h, 16)));
  const pack = fromBinary(StickerPackSchema, decryptStickerFile(response.body, key));
  report(`HTTPS to cdn.signal.org: ${response.status}, ${response.body.length} bytes, decrypted "${pack.title}" with ${pack.stickers.length} stickers`);
}

async function checkLinkCycle(): Promise<void> {
  const qr = document.getElementById('qr') as HTMLImageElement;
  const openInSignal = document.getElementById('open-signal') as HTMLAnchorElement;
  const account = await linkDevice((url) => {
    // On a phone with Signal installed, tapping the link opens Signal's own "link this device" flow.
    openInSignal.href = url;
    openInSignal.hidden = false;
    void QRCode.toDataURL(url, { margin: 2, width: 280 }).then((dataUrl) => {
      qr.src = dataUrl;
      qr.hidden = false;
    });
    report('link: tap "Open in Signal" on this phone, or scan the QR code in Signal under Settings › Linked devices');
  });
  qr.hidden = true;
  openInSignal.hidden = true;
  report(`link: OK, linked as device ${account.credentials.deviceId}`);
  const session = await SignalSession.open(account.credentials);
  try {
    const devices = await session.listDeviceIds();
    report(`login: OK, the account has ${devices.length} devices, including this one: ${devices.includes(account.credentials.deviceId)}`);
  } finally {
    await session.unlinkSelf();
    account.masterKey.fill(0);
    report('unlink: OK, device removed');
  }
}

document.getElementById('run-link')!.addEventListener('click', () => {
  output.textContent = '';
  checkLinkCycle()
    .then(() => report('DONE'))
    .catch((error) => report(`FAILED ${error instanceof Error ? error.message : String(error)}`));
});

document.getElementById('run')!.addEventListener('click', () => {
  output.textContent = '';
  checkProvisioningSocket()
    .then(() => report('DONE'))
    .catch((error) => report(`FAILED ${error instanceof Error ? error.message : String(error)}`));
});
