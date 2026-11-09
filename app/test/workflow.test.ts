// Scenarios of the workflow (app/workflow.ts): the whole wizard driven through its actions, against the scenario
// world, including reloads in between. Each test names the failure it exists to catch.

import { describe, expect, it } from 'vitest';
import { Workflow } from '../src/app/workflow';
import { appServices, Browser } from './scenario/stickers/app-services';
import { StickerWorld, type StickerUser } from './scenario/stickers/sticker-world';

const MINUTE = 60_000;

/** Waits until `condition` holds, letting the workflow's background work run. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('the condition never held');
}

/** Opens the page: a workflow with this page's services, restored from what the browser kept. */
async function openPage(user: StickerUser, browser: Browser, options: { leaveAfterWaitOf?: number } = {}) {
  const page = appServices(user, browser, options);
  const workflow = new Workflow(page.services);
  await workflow.restore();
  return { workflow, ...page };
}

/** Starts, signs in to Telegram and waits until the packs are read and looked up. */
async function signInAndReadPacks(page: Awaited<ReturnType<typeof openPage>>): Promise<void> {
  await page.workflow.start();
  await until(() => page.workflow.telegramAuth?._ === 'authorizationStateWaitPhoneNumber');
  await page.workflow.telegramSession!.invoke({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
  page.scanTelegramCode();
  await until(
    () =>
      (page.workflow.stickers?.entries.length ?? 0) > 0 &&
      page.workflow.stickers!.entries.every((e) => e.state !== 'checking'),
  );
}

async function linkAndReview(page: Awaited<ReturnType<typeof openPage>>): Promise<void> {
  page.workflow.continueFromPacks();
  await page.workflow.linkSignal(
    () => undefined,
    () => 'Sticker migration',
  );
}

describe('the workflow', () => {
  // Detects: the wizard not reaching Done, or leaving a login, a linked device or the snapshot behind at the end.
  it('runs a whole migration and clears everything at the end', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signInAndReadPacks(page);
    expect(page.workflow.route).toBe('packs');
    await linkAndReview(page);
    expect(page.workflow.route).toBe('review');
    const deviceId = page.workflow.device!.deviceId;
    await page.workflow.startMigration();
    expect(page.workflow.route).toBe('done');
    expect(page.workflow.error).toBeNull();
    expect(await alice.installedTitles()).toEqual(['A', 'B']);
    expect(browser.snapshot).toBeNull();
    expect(browser.telegramSessionKept).toBe(false);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
  });

  // Detects: a reload losing the migration: signing in and linking again, uploading packs twice, or another order.
  it('continues after a reload where the migration stopped', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 2, intervalMs: 72 * MINUTE } });
    const alice = world.user(['A', 'B', 'C', 'D', 'E'].map((title) => world.pack(title)));
    const browser = new Browser();
    const first = await openPage(alice, browser, { leaveAfterWaitOf: 10 * MINUTE });
    await signInAndReadPacks(first);
    await linkAndReview(first);
    const deviceId = first.workflow.device!.deviceId;
    await first.workflow.startMigration();
    expect(await alice.installedTitles()).toEqual(['A', 'B']);
    expect(browser.snapshot?.route).toBe('migrate');

    await world.clock.advance(5 * 60 * MINUTE);
    const second = await openPage(alice, browser);
    expect(second.workflow.route).toBe('done');
    expect(world.signal.devices(alice.aci)).toEqual([1, deviceId]);
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(5);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a deselected pack coming back selected after a reload, and being migrated against the user's choice.
  it('keeps the selection across a reload', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signInAndReadPacks(first);
    first.workflow.setSelected(
      first.workflow.stickers!.entries.filter((entry) => entry.pack.title === 'B'),
      false,
    );
    const second = await openPage(alice, browser);
    expect(second.workflow.route).toBe('packs');
    expect(second.workflow.stickers!.entries.map((entry) => entry.selected)).toEqual([true, false, true]);
  });

  // Detects: "Clear everything" leaving the Telegram session, the linked device or the snapshot behind.
  it('clears everything on request', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signInAndReadPacks(page);
    await linkAndReview(page);
    const deviceId = page.workflow.device!.deviceId;
    await page.workflow.clearEverything();
    expect(page.workflow.route).toBe('start');
    expect(browser.snapshot).toBeNull();
    expect(browser.telegramSessionKept).toBe(false);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
  });

  // Detects: the browser's storage holding the account's master key, which decrypts much more than the migration
  // needs.
  it('keeps only the storage service key, never the master key', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signInAndReadPacks(page);
    await linkAndReview(page);
    const kept = browser.snapshot!;
    expect(kept.signal?.storageServiceKey).toEqual(page.storageServiceKey);
    const bytes = JSON.stringify(kept, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value));
    expect(bytes).not.toContain(JSON.stringify(Array.from(page.masterKey)).slice(1, -1));
  });

  // Detects: the router letting the user jump to a step whose prerequisites are missing (review before linking).
  it('refuses steps that are not reachable yet', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser());
    expect(page.workflow.navigate('review')).toBe(false);
    expect(page.workflow.navigate('migrate')).toBe(false);
    expect(page.workflow.route).toBe('start');
    await signInAndReadPacks(page);
    expect(page.workflow.navigate('review')).toBe(false);
    expect(page.workflow.navigate('signal')).toBe(true);
  });
});
