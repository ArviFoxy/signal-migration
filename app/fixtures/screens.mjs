// Screenshots the screen fixtures (fixtures.ts) in headless Chrome: `node fixtures/screens.mjs [fixture ...]`, after
// `node build.mjs --fixtures`. Serves dist-fixtures on a local port, opens one tab, and for each fixture and screen
// size loads ?f=<name>, waits until the fixture says it is ready, and saves ../build/screens/<name>-<size>.png.
// CHROME names the browser (default google-chrome-stable).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchChrome } from '../integration/chrome.mjs';

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

const chrome = await launchChrome();
const tab = await chrome.openTab();
// Headless Chrome hides scrollbars unless told otherwise; the screens show them as a desktop browser does.
await tab.send('Emulation.setScrollbarsHidden', { hidden: false });

await tab.navigate(base);
await tab.waitFor('Array.isArray(window.fixtureNames)');
const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : await tab.evaluate('window.fixtureNames');
const started = Date.now();
let reportedErrors = 0;
for (const [size, metrics] of Object.entries(SIZES)) {
  await tab.send('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: 1 });
  for (const name of names) {
    const begun = Date.now();
    await tab.navigate(`${base}?f=${encodeURIComponent(name)}`);
    await tab.waitFor("document.body?.dataset.ready === 'true'", 2000);
    const { result } = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, `${name}-${size}.png`), Buffer.from(result.data, 'base64'));
    console.log(`${name}-${size}.png  ${Date.now() - begun} ms`);
    for (const error of tab.errors.slice(reportedErrors)) console.log('page error:', error);
    reportedErrors = tab.errors.length;
  }
}
console.log(
  `${names.length * Object.keys(SIZES).length} screens in ${((Date.now() - started) / 1000).toFixed(1)} s, in ${out}`,
);
await chrome.close();
server.close();
process.exit(0);
