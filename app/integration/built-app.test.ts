// The built app (dist/), served by the real server, in a real Chrome. These tests are about what only that
// combination shows: that the server sends every built file in a form the browser accepts, and that the app starts
// from them.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChrome } from './chrome.mjs';
import { buildServer, startServer } from './server.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');
let chrome: Awaited<ReturnType<typeof launchChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('dist/ is missing: run `npm run build` first');
  buildServer();
  server = await startServer(dist);
  chrome = await launchChrome();
}, 300_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

// Detects: a file the page needs to start that the server does not send or sends under a type the browser refuses
// (the module script, a stylesheet, a font), and an error thrown while the app starts.
it('starts from the files the server sends', async () => {
  const tab = await chrome.openTab();
  await tab.navigate(server.base);
  const rendered = await tab.waitFor("document.querySelector('migration-app')?.childElementCount > 0");
  expect(rendered, 'the app rendered its first screen').toBe(true);
  // Chrome asks for /favicon.ico by itself, and the app has no icon.
  const failed = tab.failedRequests.filter((request) => !request.endsWith('/favicon.ico'));
  expect(failed, 'requests that failed').toEqual([]);
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
