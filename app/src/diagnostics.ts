// Live checks of the connection to Signal through this server's relay. They use no account.

import QRCode from 'qrcode';
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
}

async function checkLinkCycle(): Promise<void> {
  const qr = document.getElementById('qr') as HTMLImageElement;
  const account = await linkDevice((url) => {
    void QRCode.toDataURL(url, { margin: 2, width: 280 }).then((dataUrl) => {
      qr.src = dataUrl;
      qr.hidden = false;
    });
    report('link: QR code shown; scan it in Signal under Settings › Linked devices');
  });
  qr.hidden = true;
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
