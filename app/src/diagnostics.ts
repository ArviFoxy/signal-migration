// Live checks of the connection to Signal through this server's relay. They use no account.

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

document.getElementById('run')!.addEventListener('click', () => {
  output.textContent = '';
  checkProvisioningSocket()
    .then(() => report('DONE'))
    .catch((error) => report(`FAILED ${error instanceof Error ? error.message : String(error)}`));
});
