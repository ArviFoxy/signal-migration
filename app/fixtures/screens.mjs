// Screenshots the screen fixtures (fixtures.ts) in headless Chrome: `node fixtures/screens.mjs [fixture ...]`, after
// `node build.mjs --fixtures`. Serves dist-fixtures on a local port, opens one tab, and for each fixture and screen
// size loads ?f=<name>, waits until the fixture says it is ready, and saves ../build/screens/<name>-<size>.png.
// CHROME names the browser (default google-chrome-stable).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const SIZES = {
  desktop: { width: 1440, height: 900, mobile: false },
  phone: { width: 390, height: 844, mobile: true },
};
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
const root = path.resolve('dist-fixtures');
const out = path.resolve('../build/screens');
fs.mkdirSync(out, { recursive: true });

const server = http.createServer((request, response) => {
  const file = path.join(root, new URL(request.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  if (!file.startsWith(root) || !fs.existsSync(file)) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-'));
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome-stable',
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);
const portFile = path.join(profile, 'DevToolsActivePort');
for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
const browser = new WebSocket(
  (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl,
);
await new Promise((resolve) => (browser.onopen = resolve));
let id = 0;
const pending = new Map();
browser.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  else if (message.method === 'Runtime.exceptionThrown')
    console.log(
      'page error:',
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
    );
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    pending.set(++id, resolve);
    browser.send(JSON.stringify({ id, method, params, sessionId }));
  });
const { result: target } = await send('Target.createTarget', { url: 'about:blank' });
const { result: attached } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const tab = attached.sessionId;
await send('Runtime.enable', {}, tab);
// Headless Chrome hides scrollbars unless told otherwise; the screens show them as a desktop browser does.
await send('Emulation.setScrollbarsHidden', { hidden: false }, tab);
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, tab)).result?.result?.value;

await send('Page.navigate', { url: base }, tab);
for (let i = 0; i < 100 && !(await evaluate('Array.isArray(window.fixtureNames)')); i++)
  await new Promise((r) => setTimeout(r, 50));
const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : await evaluate('window.fixtureNames');
const started = Date.now();
for (const [size, metrics] of Object.entries(SIZES)) {
  await send('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: 1 }, tab);
  for (const name of names) {
    const begun = Date.now();
    await send('Page.navigate', { url: `${base}?f=${encodeURIComponent(name)}` }, tab);
    for (let i = 0; i < 200 && !(await evaluate("document.body?.dataset.ready === 'true'")); i++)
      await new Promise((r) => setTimeout(r, 10));
    const { result } = await send('Page.captureScreenshot', { format: 'png' }, tab);
    fs.writeFileSync(path.join(out, `${name}-${size}.png`), Buffer.from(result.data, 'base64'));
    console.log(`${name}-${size}.png  ${Date.now() - begun} ms`);
  }
}
console.log(
  `${names.length * Object.keys(SIZES).length} screens in ${((Date.now() - started) / 1000).toFixed(1)} s, in ${out}`,
);
chrome.kill();
server.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
