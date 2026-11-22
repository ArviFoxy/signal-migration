// The built app (dist/), served by the real server and under a subpath (as on GitHub Pages), in a real Chrome.
// These tests are about what only that combination shows: that every built file loads with valid SRI and MIME types,
// that relative paths work under a subpath, and that the unattested local build settles to "Unverified build".

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChrome } from './chrome.mjs';
import { buildServer, startServer } from './server.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

let chrome: Awaited<ReturnType<typeof launchChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let subpathServer: http.Server;
let subpathBase: string;

beforeAll(async () => {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
  buildServer();
  server = await startServer(dist);
  subpathServer = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    if (!pathname.startsWith('/signal-migration/')) {
      response.writeHead(404).end();
      return;
    }
    const rel = pathname.slice('/signal-migration/'.length) || 'index.html';
    const file = path.resolve(dist, rel);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => subpathServer.listen(0, '127.0.0.1', () => resolve()));
  const address = subpathServer.address();
  if (!address || typeof address === 'string') throw new Error('unexpected subpath server address');
  subpathBase = `http://127.0.0.1:${address.port}/signal-migration/`;
  chrome = await launchChrome();
}, 300_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
  await new Promise<void>((resolve) => subpathServer?.close(() => resolve()));
});

const unexpectedFailures = (requests: string[]) =>
  requests.filter((request) => !request.endsWith('/favicon.ico') && !request.endsWith('/attestation.sigstore.json'));

// Detects: a file the page needs to start that the server does not send or sends under a type or hash the browser
// refuses (the module script, a stylesheet, a font, SRI mismatch), and an error thrown while the app starts.
it('starts from the files the server sends and marks an unattested build as unverified', async () => {
  const tab = await chrome.openTab();
  await tab.navigate(server.base);
  const rendered = await tab.waitFor("document.querySelector('migration-app')?.childElementCount > 0");
  expect(rendered, 'the app rendered its first screen').toBe(true);
  const settled = await tab.waitFor("document.body.textContent?.includes('Unverified build')");
  expect(settled, 'local build without attestation shows Unverified build').toBe(true);
  expect(unexpectedFailures(tab.failedRequests), 'requests that failed').toEqual([]);
  expect(tab.errors, 'uncaught errors in the page').toEqual([]);
});

// Detects: a WebAssembly module of the build that the browser cannot start from the server's response, for example
// because the response has the wrong type or its compressed copy is broken. The browser compiles a module while it
// downloads only when the response says it is WebAssembly.
it('compiles every WebAssembly module of the build from the server', async () => {
  const modules = fs.readdirSync(dist).filter((file) => file.endsWith('.wasm'));
  expect(modules.length, 'WebAssembly modules in dist/').toBeGreaterThan(0);
  const tab = await chrome.openTab();
  await tab.navigate(server.base);
  for (const module of modules) {
    const outcome = await tab.evaluate(
      `WebAssembly.compileStreaming(fetch('/${module}')).then(() => 'compiled', (error) => String(error))`,
    );
    expect(outcome, module).toBe('compiled');
  }
});

// Detects: hardcoded root-relative (`/`) paths that break when the app is served under a subpath on GitHub Pages.
it('starts and compiles WebAssembly modules when hosted under a subpath', async () => {
  const modules = fs.readdirSync(dist).filter((file) => file.endsWith('.wasm'));
  const tab = await chrome.openTab();
  await tab.navigate(subpathBase);
  const rendered = await tab.waitFor("document.querySelector('migration-app')?.childElementCount > 0");
  expect(rendered, 'the app rendered under /signal-migration/').toBe(true);
  const settled = await tab.waitFor("document.body.textContent?.includes('Unverified build')");
  expect(settled, 'subpath unattested build shows Unverified build').toBe(true);
  for (const module of modules) {
    const outcome = await tab.evaluate(
      `WebAssembly.compileStreaming(fetch('./${module}')).then(() => 'compiled', (error) => String(error))`,
    );
    expect(outcome, module).toBe('compiled');
  }
  expect(unexpectedFailures(tab.failedRequests), 'requests that failed under subpath').toEqual([]);
  expect(tab.errors, 'uncaught errors in the page under subpath').toEqual([]);
});
