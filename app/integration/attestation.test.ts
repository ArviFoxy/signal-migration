// The attestation module in a real Chrome, loaded from the real server. The module is BoringSSL and libsignal's
// check built for WebAssembly (crates/attestation-wasm); the unit tests run it in Node. This test is about what only
// the browser and the server show together: that the module the server sends starts in a browser and that the check
// gives the right answers there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchChrome } from './chrome.mjs';
import { buildServer, startServer } from './server.mjs';

const dist = path.resolve(import.meta.dirname, '../dist');
/** The attestation of a contact discovery enclave that libsignal's own tests record. */
const recorded = path.resolve(import.meta.dirname, '../../third_party/libsignal/rust/attest/tests/data');
let site: string;
let chrome: Awaited<ReturnType<typeof launchChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  if (!fs.existsSync(path.join(dist, 'attestation_wasm_bg.wasm')))
    throw new Error('dist/ is missing: run `npm run build` first');
  // The built app, with the module's loader as a file of its own (the app has it inside its bundle) and the
  // recorded attestation beside it.
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'attestation-site-'));
  fs.cpSync(dist, site, { recursive: true });
  fs.copyFileSync(path.resolve(import.meta.dirname, '../src/wasm/attestation_wasm.js'), `${site}/loader.js`);
  for (const part of ['mrenclave', 'handshakestart', 'timestamp'])
    fs.copyFileSync(path.join(recorded, `cdsi.${part}`), `${site}/recorded-${part}.bin`);
  buildServer();
  server = await startServer(site);
  chrome = await launchChrome();
}, 300_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
  if (site) fs.rmSync(site, { recursive: true, force: true });
});

// Detects: a module that the browser cannot start from the server's response, and a check that accepts in the
// browser what it must refuse (or refuses everything), which the same code in Node would not show.
it('accepts the recorded attestation in the browser and refuses a changed or outdated one', async () => {
  const tab = await chrome.openTab();
  await tab.navigate(server.base);
  const outcome = await tab.evaluate(`(async () => {
    const module = await import('/loader.js');
    await module.default({ module_or_path: '/attestation_wasm_bg.wasm' });
    const bytes = async (part) => new Uint8Array(await (await fetch('/recorded-' + part + '.bin')).arrayBuffer());
    const [enclaveId, attestation, timestamp] = await Promise.all(['mrenclave', 'handshakestart', 'timestamp'].map(bytes));
    const recordedAt = Number(new DataView(timestamp.buffer).getBigUint64(0));
    const check = (message, time) => {
      try {
        return module.EnclaveHandshake.forContactDiscovery(enclaveId, message, time).initialRequest().length > 0
          ? 'accepted'
          : 'empty';
      } catch {
        return 'refused';
      }
    };
    const changed = attestation.slice();
    changed[changed.length >> 1] ^= 1;
    const twoYears = 2 * 365 * 24 * 3600;
    return [check(attestation, recordedAt), check(changed, recordedAt), check(attestation, recordedAt + twoYears)].join(', ');
  })()`);
  expect(outcome).toBe('accepted, refused, refused');
  expect(tab.errors, 'uncaught errors in the page').toEqual([]);
});
