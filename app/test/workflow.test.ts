// Scenarios of the workflow (app/workflow.ts): the whole app driven the way the user drives it, against the scenario
// world, with reloads and closed pages in between. Each test names the failure it exists to catch.

import { describe, expect, it } from 'vitest';
import { Workflow } from '../src/app/workflow';
import { appServices, Browser, TelegramServer } from './scenario/stickers/app-services';
import { StickerWorld, type StickerUser } from './scenario/stickers/sticker-world';

const MINUTE = 60_000;

/** Waits until `condition` holds, letting the page's background work run. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`${what}: never happened`);
}

/** Lets the page's background work run until nothing more happens. */
async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await page.workflow.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Opens the page: a workflow with this page's services, continuing from what the browser kept. */
async function openPage(user: StickerUser, browser: Browser, options: Parameters<typeof appServices>[2] = {}) {
  const page = appServices(user, browser, options);
  const workflow = new Workflow(page.services);
  await workflow.load();
  return { workflow, ...page };
}
type Page = Awaited<ReturnType<typeof openPage>>;

/** Presses Start and scans the Telegram code; returns once the packs are read and looked up. */
async function signIn(page: Page): Promise<void> {
  page.workflow.goTo('packs');
  await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
  await until(() => page.workflow.step === 'packs' && page.workflow.packsReady, 'the packs');
}

/** Continues from the packs and scans the Signal code; returns on the review. */
async function link(page: Page): Promise<void> {
  page.workflow.goTo('review');
  await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
  await until(() => page.workflow.step === 'review' && page.workflow.packsReady, 'the review');
}

async function migrate(page: Page): Promise<void> {
  page.workflow.startMigration();
  await until(() => page.workflow.phase.kind === 'finished', 'the end of the migration');
  await settle(page);
}

const deviceIdOf = (page: Page) => page.workflow.signal.device!.deviceId;

describe('the workflow', () => {
  // Detects: the app not reaching the end, or leaving a Telegram session, a linked device, Telegram data or the
  // snapshot behind at the end.
  it('runs a whole migration and ends both logins at the end', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signIn(page);
    await link(page);
    const deviceId = deviceIdOf(page);
    await migrate(page);
    expect(page.workflow.step).toBe('migrate');
    expect(await alice.installedTitles()).toEqual(['A', 'B']);
    expect(page.server.active.size).toBe(0);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
    expect(browser.instances.size).toBe(0);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a reload losing the migration: signing in and linking again, uploading packs twice, or another order.
  it('continues after a reload where the migration stopped', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 2, intervalMs: 72 * MINUTE } });
    const alice = world.user(['A', 'B', 'C', 'D', 'E'].map((title) => world.pack(title)));
    const browser = new Browser();
    const first = await openPage(alice, browser, { leaveAfterWaitOf: 10 * MINUTE });
    await signIn(first);
    await link(first);
    const deviceId = deviceIdOf(first);
    first.workflow.startMigration();
    await until(() => first.workflow.error !== null, 'the first page leaving during the wait');
    expect(await alice.installedTitles()).toEqual(['A', 'B']);
    browser.closePage();

    await world.clock.advance(5 * 60 * MINUTE);
    const second = await openPage(alice, browser);
    await until(() => second.workflow.phase.kind === 'finished', 'the end of the migration');
    await settle(second);
    expect(second.server.active.size).toBe(0);
    expect(world.signal.devices(alice.aci)).toEqual([1, deviceId]);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(5);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a login saved only by tdweb's periodic copy or when the page closes: a page closed right after
  // signing in then loses the login, and its session stays active on Telegram with nothing left to end it.
  it('keeps a login that a page closed right after signing in', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    browser.closePage();

    const second = await openPage(alice, browser);
    await until(() => second.workflow.step === 'packs' && second.workflow.packsReady, 'the packs after the reload');
    expect(second.server.active.size).toBe(1);
  });

  // Detects: a deselected pack coming back selected after a reload, and being migrated against the user's choice.
  it('keeps the selection across a reload', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    first.workflow.setSelected(
      first.workflow.stickers!.entries.filter((entry) => entry.pack.title === 'B'),
      false,
    );
    await settle(first);
    browser.closePage();
    const second = await openPage(alice, browser);
    await until(() => second.workflow.packsReady, 'the packs after the reload');
    expect(second.workflow.step).toBe('packs');
    expect(second.workflow.stickers!.entries.map((entry) => entry.selected)).toEqual([true, false, true]);
  });

  // Detects: "Disconnect and clear local state" leaving the Telegram session active, the device linked, or data in
  // the browser; or waiting for TDLib to report that it closed, which never happens here.
  it('ends both logins and deletes everything kept on "Disconnect and clear"', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser, { withholdClosing: true });
    await signIn(page);
    await link(page);
    const deviceId = deviceIdOf(page);
    await page.workflow.clear();
    await settle(page);
    expect(page.workflow.step).toBe('start');
    expect(page.server.active.size).toBe(0);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
    expect(browser.instances.size).toBe(0);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a page closed while signing out leaving the Telegram session active, or the next visit waiting
  // forever for a login ("waiting for sign-in").
  it('finishes a sign-out that a closed page left unfinished', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    void first.workflow.clear();
    await until(() => first.workflow.telegram.state.kind === 'stopping', 'signing out');
    browser.syncTdlib();
    browser.closePage();
    expect(first.server.active.size).toBe(1);

    const second = await openPage(alice, browser);
    await until(() => second.workflow.telegram.state.kind === 'off', 'the end of the sign-out');
    await settle(second);
    expect(second.server.active.size).toBe(0);
    expect(second.workflow.step).toBe('start');
    expect(browser.instances.size).toBe(0);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a replaced TDLib client's late updates overriding the current login ("Signed out of Telegram" after
  // switching between the QR code and the phone number), or replaced clients left running or stored.
  it('follows only the current login when switching between QR code and phone number', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    const login = page.workflow.telegram;
    page.workflow.goTo('packs');
    await until(() => login.state.kind === 'login', 'the login');
    for (const method of ['phone', 'qr', 'phone', 'qr', 'phone'] as const) void login.useMethod(method);
    await settle(page);
    expect(login.state.kind === 'login' && login.state.auth._).toBe('authorizationStateWaitPhoneNumber');
    expect(page.started.filter((client) => !client.disposed)).toHaveLength(1);
    expect(browser.instances.size).toBe(1);

    await login.submit({ _: 'setAuthenticationPhoneNumber', phone_number: '+1 555 0100' });
    await login.submit({ _: 'checkAuthenticationCode', code: TelegramServer.CODE });
    await until(() => page.workflow.step === 'packs', 'the packs');
    expect(page.server.active.size).toBe(1);
  });

  // Detects: the step on screen depending on how the user got there instead of on the state: after Signal is
  // unlinked from the phone during the review, the review stays (with a dead device) or the Signal step does not
  // come back to the review once linked again.
  it('shows the step that the state allows, whatever happened before', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser());
    await signIn(page);
    await link(page);
    alice.phone.unlink(deviceIdOf(page));
    page.workflow.signal.device!.onUnlinked();
    await until(() => page.workflow.step === 'signal', 'the Signal step');
    await until(() => page.scanSignalCode(), 'a new Signal QR code');
    await until(() => page.workflow.step === 'review' && page.workflow.packsReady, 'the review again');
    expect(page.workflow.signal.state.kind).toBe('linked');
  });

  // Detects: linking going on in the background after the user left the Signal step, and linking a device the user
  // no longer expects.
  it('stops linking when the Signal step is left', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser());
    await signIn(page);
    page.workflow.goTo('review');
    await until(() => page.workflow.signal.state.kind === 'linking', 'linking');
    page.workflow.goTo('packs');
    await settle(page);
    expect(page.workflow.signal.state.kind).toBe('off');
    expect(page.scanSignalCode()).toBe(true);
    await settle(page);
    expect(world.signal.devices(alice.aci)).toEqual([1]);
  });

  // Detects: the address bar or a Back button reaching a step whose needs are not met (the review before linking).
  it('shows the furthest step whose needs are met when a later one is asked for', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser());
    expect(page.workflow.goTo('migrate')).toBe(false);
    page.workflow.goTo('review');
    expect(page.workflow.step).toBe('telegram');
    await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
    await until(() => page.workflow.step === 'signal', 'the Signal step');
  });

  // Detects: the browser's storage holding the account's master key, which decrypts much more than the migration
  // needs.
  it('keeps only the storage service key, never the master key', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signIn(page);
    await link(page);
    await settle(page);
    const kept = browser.snapshot as { signal: { storageServiceKey: Uint8Array } };
    expect(kept.signal.storageServiceKey).toEqual(page.storageServiceKey);
    const bytes = JSON.stringify(kept, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value));
    expect(bytes).not.toContain(JSON.stringify(Array.from(page.masterKey)).slice(1, -1));
  });
});
