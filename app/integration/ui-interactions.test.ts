// Real-Chrome UI interaction & fixture-wide invariant tests.
// Part 1 verifies specific DOM interaction edge cases (autofill, whitespace passwords, auth input clearing, QR retry,
// right-click timeline guard, pack-reading progress, migrate dead-ends, toast dismissal, mobile connections-sheet).
// Part 2 sweeps every screen fixture in fixtures/fixtures.ts at desktop (1440x900) and phone (390x844) to catch
// blank renders, uncaught errors, horizontal overflow, and dead toast dismiss buttons across the entire app.

import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChrome } from './chrome.mjs';

const app = path.resolve(import.meta.dirname, '..');
const tdwebDist = path.resolve(app, '../build/tdweb/dist');
const webmDecoder = path.resolve(app, '../build/webm-decoder');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

let chrome: Awaited<ReturnType<typeof launchChrome>>;
let server: http.Server;
let base: string;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-interactions-'));
  await build({
    entryPoints: ['integration/ui-interactions-page.ts', 'fixtures/fixtures.ts', 'src/fonts.css'],
    entryNames: '[name]',
    assetNames: 'fonts/[name]-[hash]',
    absWorkingDir: app,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: root,
    loader: { '.woff2': 'file', '.woff': 'file' },
    alias: {
      tdweb: path.join(tdwebDist, 'tdweb.js'),
      'webm-decoder': path.join(webmDecoder, 'webm-decoder.js'),
    },
    external: ['node:*'],
    logLevel: 'silent',
  });
  execFileSync(
    path.join(app, 'node_modules/.bin/tailwindcss'),
    ['--input', 'src/styles.css', '--output', path.join(root, 'styles.css'), '--minify'],
    { cwd: app, stdio: 'pipe' },
  );
  fs.writeFileSync(
    path.join(root, 'harness.html'),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/styles.css"><script type="module" src="/ui-interactions-page.js"></script>',
  );
  fs.copyFileSync(path.join(app, 'fixtures/fixtures.html'), path.join(root, 'fixtures.html'));

  server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const rel = pathname === '/' ? 'harness.html' : pathname.slice(1);
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

async function runHarness<T>(
  name: string,
  viewport: { width: number; height: number; mobile: boolean } = { width: 1440, height: 900, mobile: false },
): Promise<{ result: T; errors: string[] }> {
  const tab = await chrome.openTab();
  await tab.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1 });
  await tab.navigate(`${base}harness.html`);
  const ready = await tab.waitFor("typeof window.uiTests === 'object'");
  expect(ready).toBe(true);
  const result = (await tab.evaluate(`window.uiTests.${name}()`)) as T;
  return { result, errors: [...tab.errors] };
}

describe('UI interactions in real Chrome', () => {
  it('handles browser autofill Event (undefined inputType) in <phone-input> without throwing', async () => {
    const { result, errors } = await runHarness<{ value: string | null; emitted: (string | null)[] }>(
      'phoneInputAutofill',
    );
    expect(errors).toEqual([]);
    expect(result.value).toBe('+12015550123');
    expect(result.emitted).toContain('+12015550123');
  });

  it('preserves leading and trailing spaces in Telegram 2FA passwords', async () => {
    const { result, errors } = await runHarness<{ events: { type: string; query?: { password?: string } }[] }>(
      'telegramPasswordPreservesWhitespace',
    );
    expect(errors).toEqual([]);
    expect(result.events).toContainEqual({
      type: 'telegram/submit',
      query: { _: 'checkAuthenticationPassword', password: '  padded pass  ' },
    });
  });

  it('clears the code input when transitioning from WaitCode to WaitEmailCode', async () => {
    const { result, errors } = await runHarness<{ emailInputValue: string }>('telegramCodeToEmailClearsInput');
    expect(errors).toEqual([]);
    expect(result.emailInputValue).toBe('');
  });

  it('shows a Try again button when Telegram QR code request fails', async () => {
    const { result, errors } = await runHarness<{ hasRetryButton: boolean; dispatchedRetry: boolean }>(
      'telegramQrErrorHasRetryButton',
    );
    expect(errors).toEqual([]);
    expect(result.hasRetryButton).toBe(true);
    expect(result.dispatchedRetry).toBe(true);
  });

  it('disables Telegram method-switch buttons while a login request is sending', async () => {
    const { result, errors } = await runHarness<{ phoneToQrDisabled: boolean; qrToPhoneDisabled: boolean }>(
      'telegramSwitchDisabledWhileSending',
    );
    expect(errors).toEqual([]);
    expect(result.phoneToQrDisabled).toBe(true);
    expect(result.qrToPhoneDisabled).toBe(true);
  });

  it('ignores right-click pointerdown on the Saved Messages timeline', async () => {
    const { result, errors } = await runHarness<{ committed: (number | null)[] }>('savedStepIgnoresRightClick');
    expect(errors).toEqual([]);
    expect(result.committed).toEqual([]);
  });

  it('renders pack-reading progress bar while packs are reading before migration exists', async () => {
    const { result, errors } = await runHarness<{ hasProgressBar: boolean; text: string }>(
      'packsStepShowsReadingProgress',
    );
    expect(errors).toEqual([]);
    expect(result.hasProgressBar).toBe(true);
    expect(result.text).toContain('3 of 10 packs');
  });

  it('renders Start over on <migrate-step> when finished without a migration object', async () => {
    const { result, errors } = await runHarness<{ buttons: string[] }>(
      'migrateStepFinishedWithoutMigrationHasStartOver',
    );
    expect(errors).toEqual([]);
    expect(result.buttons).toContain('Start over');
  });

  it('renders Back to start, Try again, and Finish when a non-sticker migration fails', async () => {
    const { result, errors } = await runHarness<{ buttons: string[] }>(
      'migrateStepWithoutPacksFailedHasBackTryAgainFinish',
    );
    expect(errors).toEqual([]);
    expect(result.buttons).toEqual(expect.arrayContaining(['Back to start', 'Try again', 'Finish']));
  });

  it('shows Looking for your friends on <migrate-step> while friends are still loading', async () => {
    const { result, errors } = await runHarness<{ text: string }>('migrateStepShowsLookingForFriends');
    expect(errors).toEqual([]);
    expect(result.text).toContain('Looking for your friends');
    expect(result.text).not.toContain('Nobody to add');
  });

  it('hides the toast banner when clicking Dismiss even for non-dismissible workflow errors', async () => {
    const { result, errors } = await runHarness<{ hadToastBefore: boolean; hasToastAfter: boolean }>(
      'migrationAppDismissHidesNonDismissibleErrorToast',
    );
    expect(errors).toEqual([]);
    expect(result.hadToastBefore).toBe(true);
    expect(result.hasToastAfter).toBe(false);
  });

  it('keeps mobile connections-sheet in bounds, hoists clear-everything popover, and closes on Sign out', async () => {
    const { result, errors } = await runHarness<{
      clearPopoverCount: number;
      nestedClearPopover: boolean;
      openBefore: boolean;
      cardVisible: boolean;
      cardFitsHorizontally: boolean;
      sheetFitsViewport: boolean;
      openAfterSignOut: boolean;
    }>('mobileConnectionsSheetBehavior', { width: 390, height: 844, mobile: true });
    expect(errors).toEqual([]);
    expect(result.clearPopoverCount).toBe(1);
    expect(result.nestedClearPopover).toBe(false);
    expect(result.openBefore).toBe(true);
    expect(result.cardVisible).toBe(true);
    expect(result.cardFitsHorizontally).toBe(true);
    expect(result.sheetFitsViewport).toBe(true);
    expect(result.openAfterSignOut).toBe(false);
  });
});

describe('fixture-wide UI invariants', () => {
  it('renders every screen fixture cleanly at desktop and phone sizes with no errors, overflow, or dead toasts', async () => {
    const tab = await chrome.openTab();
    await tab.navigate(`${base}fixtures.html`);
    const loaded = await tab.waitFor('Array.isArray(window.fixtureNames)');
    expect(loaded).toBe(true);
    const names = (await tab.evaluate('window.fixtureNames')) as string[];
    expect(names.length).toBeGreaterThan(20);

    const viewports = [
      { label: 'desktop', width: 1440, height: 900, mobile: false },
      { label: 'phone', width: 390, height: 844, mobile: true },
    ];
    const problems: string[] = [];

    for (const vp of viewports) {
      await tab.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        mobile: vp.mobile,
        deviceScaleFactor: 1,
      });
      for (const name of names) {
        const errorsBefore = tab.errors.length;
        await tab.navigate(`${base}fixtures.html?f=${encodeURIComponent(name)}`);
        const ready = await tab.waitFor("document.body?.dataset.ready === 'true'", 5000);
        if (!ready) {
          problems.push(`${name}@${vp.label}: fixture did not become ready`);
          continue;
        }
        const check = (await tab.evaluate(`(async () => {
          const main = document.querySelector('main');
          const text = (main?.textContent ?? '').trim();
          const overflow = document.documentElement.scrollWidth - window.innerWidth;
          let deadDismiss = false;
          const dismiss = document.querySelector('[role="alert"] button[aria-label="Dismiss"]');
          if (dismiss) {
            dismiss.click();
            const appEl = document.querySelector('migration-app');
            if (appEl && 'updateComplete' in appEl) await appEl.updateComplete;
            deadDismiss = Boolean(document.querySelector('[role="alert"] button[aria-label="Dismiss"]'));
          }
          return { hasContent: text.length > 0, overflow, deadDismiss };
        })()`)) as { hasContent: boolean; overflow: number; deadDismiss: boolean };
        if (!check.hasContent) problems.push(`${name}@${vp.label}: empty <main>`);
        if (check.overflow > 1) problems.push(`${name}@${vp.label}: horizontal overflow ${check.overflow}px`);
        if (check.deadDismiss) problems.push(`${name}@${vp.label}: Dismiss button did not hide toast`);
        for (const err of tab.errors.slice(errorsBefore)) problems.push(`${name}@${vp.label}: page error: ${err}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
