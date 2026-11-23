// Real Chrome + real tdweb integration test: verifies that when TDLib hits a fatal error in Run 1,
// TelegramClient closes Run 1's BroadcastChannel and worker cleanly so Run 2 starts instead of deadlocking
// in tdweb's closeOtherClients handshake.

import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChrome } from './chrome.mjs';

const app = path.resolve(import.meta.dirname, '..');
const tdwebDist = path.resolve(app, '../build/tdweb/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

let chrome: Awaited<ReturnType<typeof launchChrome>>;
let server: http.Server;
let base: string;
let root: string;

beforeAll(async () => {
  if (!fs.existsSync(path.join(tdwebDist, 'tdweb.js'))) {
    throw new Error('build/tdweb/dist is missing: run scripts/build-tdweb-js.sh first');
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdlib-restart-'));
  for (const file of fs.readdirSync(tdwebDist)) {
    if (file !== 'tdweb.js') fs.copyFileSync(path.join(tdwebDist, file), path.join(root, file));
  }
  await build({
    entryPoints: ['integration/tdlib-restart-page.ts'],
    entryNames: '[name]',
    absWorkingDir: app,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: root,
    alias: { tdweb: path.join(tdwebDist, 'tdweb.js') },
    external: ['node:*'],
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><meta charset="utf-8"><script type="module" src="/tdlib-restart-page.js"></script>',
  );
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected server address');
  base = `http://127.0.0.1:${address.port}/`;
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// Detects: real tdweb Run 2 deadlocking forever in closeOtherClients() because Run 1's BroadcastChannel was never
// closed after Run 1's worker was terminated on updateFatalError.
it('restarts real tdweb cleanly after a fatal error without BroadcastChannel deadlock', async () => {
  const tab = await chrome.openTab();
  await tab.navigate(base);
  const ready = await tab.waitFor("typeof window.runTdlibRestartTest === 'function'");
  expect(ready).toBe(true);

  const report = (await tab.evaluate('window.runTdlibRestartTest()')) as {
    run1State: string | null;
    run2State: string | null;
    runCount: number;
    fatalEvents: [string, boolean][];
    syncResults: string[];
    error?: string;
  };
  expect(report.error).toBeUndefined();
  expect(report.run1State).toBe('authorizationStateWaitPhoneNumber');
  expect(report.run2State).toBe('authorizationStateWaitPhoneNumber');
  expect(report.runCount).toBe(2);
  expect(report.fatalEvents).toEqual([['simulated fatal', true]]);
  expect(report.syncResults).toEqual(['ok', 'ok']);
  expect(tab.errors).toEqual([]);
}, 30_000);
