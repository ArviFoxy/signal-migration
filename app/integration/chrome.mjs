// Drives a headless Chrome over its DevTools protocol, for the integration tests and the screen fixtures. No browser
// automation library is involved: Chrome is started with a debugging port, and commands go over one WebSocket.
// CHROME names the browser (default google-chrome-stable).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Starts Chrome with a new profile. `send` sends one DevTools command and resolves to its answer; `onEvent` is
 * called with every event Chrome reports. `close` stops Chrome and removes the profile.
 */
export async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
  const chrome = spawn(
    process.env.CHROME ?? 'google-chrome-stable',
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
    { stdio: 'ignore' },
  );
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await pause(50);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const socket = new WebSocket(
    (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl,
  );
  await new Promise((resolve) => (socket.onopen = resolve));
  let lastId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      pending.set(++lastId, resolve);
      socket.send(JSON.stringify({ id: lastId, method, params, sessionId }));
    });
  return {
    send,
    onEvent: (listener) => listeners.add(listener),
    /** Opens a tab; see `openTab`. */
    openTab: () => openTab(send, (listener) => listeners.add(listener)),
    // Chrome writes to its profile while it shuts down, so the profile is removed only after it has exited.
    async close() {
      await new Promise((resolve) => {
        chrome.once('exit', resolve);
        chrome.kill();
      });
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/**
 * Opens a tab and watches it. `errors` collects every uncaught error of the page and `failedRequests` every request
 * that did not load or that the server answered with a status of 400 or above; both keep growing while the tab lives.
 */
async function openTab(send, onEvent) {
  const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  const errors = [];
  const failedRequests = [];
  const urls = new Map();
  onEvent((message) => {
    if (message.sessionId !== session) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown')
      errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    else if (method === 'Network.requestWillBeSent') urls.set(params.requestId, params.request.url);
    else if (method === 'Network.responseReceived' && params.response.status >= 400)
      failedRequests.push(`${params.response.status} ${params.response.url}`);
    else if (method === 'Network.loadingFailed' && !params.canceled)
      failedRequests.push(`${params.errorText} ${urls.get(params.requestId) ?? ''}`);
  });
  await send('Runtime.enable', {}, session);
  await send('Network.enable', {}, session);
  const command = (method, params = {}) => send(method, params, session);
  /** The value of a JavaScript expression in the page; a promise is awaited. */
  const evaluate = async (expression) =>
    (await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  return {
    send: command,
    evaluate,
    errors,
    failedRequests,
    navigate: (url) => command('Page.navigate', { url }),
    /** Waits until `expression` is true in the page; false when it is not within the time limit. */
    async waitFor(expression, timeLimitMs = 5000) {
      for (const start = Date.now(); Date.now() - start < timeLimitMs; await pause(20)) {
        if (await evaluate(`Boolean(${expression})`)) return true;
      }
      return false;
    },
  };
}
