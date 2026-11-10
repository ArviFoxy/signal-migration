// Scenarios of the workflow (app/workflow.ts): the whole app driven the way the user drives it, against the scenario
// world, with reloads and closed pages in between. Each test names the failure it exists to catch.

import { describe, expect, it } from 'vitest';
import { isSession } from '../src/app/machine/app';
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
  workflow.start();
  await until(() => isSession(workflow.state), 'the page loaded');
  return { workflow, ...page };
}
type Page = Awaited<ReturnType<typeof openPage>>;

/** Presses Start and scans the Telegram code; returns on the Signal step, once the packs are read and looked up. */
async function signIn(page: Page): Promise<void> {
  page.workflow.goTo('packs');
  await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
  await until(() => page.workflow.step === 'signal' && page.workflow.packsReady, 'the Signal step');
}

/** Scans the Signal code, then continues from the packs; returns on the review. */
async function link(page: Page): Promise<void> {
  await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
  await until(() => page.workflow.step === 'packs' && page.workflow.packsReady, 'the packs');
  page.workflow.goTo('review');
  await until(() => page.workflow.step === 'review' && page.workflow.packsReady, 'the review');
}

async function migrate(page: Page): Promise<void> {
  page.workflow.startMigration();
  await until(() => page.workflow.state.kind === 'done', 'the end of the migration');
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
    await until(() => second.workflow.state.kind === 'done', 'the end of the migration');
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
    await until(
      () => second.workflow.step === 'signal' && second.workflow.packsReady,
      'the Signal step after the reload',
    );
    expect(second.server.active.size).toBe(1);
  });

  // Detects: a reload continuing a login that never completed, whose QR code TDLib restores with its token, which may
  // have expired (Telegram then answers AUTH_TOKEN_EXPIRED to the scan).
  it('starts a new login after a reload during one that never completed', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    first.workflow.goTo('packs');
    await until(() => first.workflow.telegram.state.kind === 'login', 'the login');
    const unfinished = first.workflow.telegram.instance;
    await settle(first);
    browser.closePage();

    const second = await openPage(alice, browser);
    await until(() => second.workflow.telegram.state.kind === 'login', 'a login');
    await settle(second);
    expect(second.workflow.telegram.instance).not.toBe(unfinished);
    expect(browser.instances.has(unfinished!)).toBe(false);
    await until(() => second.scanTelegramCode(), 'a Telegram QR code to scan');
    await until(() => second.workflow.step === 'signal', 'the Signal step');
  });

  // Detects: a restart of TDLib after an internal error stopping or restarting the migration, asking to sign in
  // again, or leaving packs out; and the user not being told.
  it('goes on with the migration when TDLib restarts after an internal error', async () => {
    const world = new StickerWorld();
    const alice = world.user(['A', 'B', 'C'].map((title) => world.pack(title)));
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signIn(page);
    await link(page);
    page.workflow.startMigration();
    await until(
      () => page.workflow.stickers?.entries.some((entry) => entry.state === 'in-signal') ?? false,
      'the first pack in Signal',
    );
    const states: string[] = [];
    page.workflow.addEventListener('change', () => {
      if (page.workflow.state.kind === 'migrating') states.push(page.workflow.telegram.state.kind);
    });
    page.started.at(-1)!.crash();
    await migrate(page);
    expect(page.workflow.notice).toBe(
      "Telegram's library stopped after an internal error and was restarted. (TDLib: Aborted())",
    );
    expect(new Set(states)).toEqual(new Set(['signed-in']));
    expect(page.started.length).toBe(1);
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(3);
  });

  // Detects: a TDLib that stopped during the login left on screen with a QR code that can never complete.
  it('starts a new login when TDLib stops during the login', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    page.workflow.goTo('packs');
    await until(
      () =>
        page.workflow.telegram.state.kind === 'login' &&
        page.workflow.telegram.state.auth._ === 'authorizationStateWaitOtherDeviceConfirmation',
      'the QR code',
    );
    const stopped = page.workflow.telegram.instance!;
    page.started.at(-1)!.crash();
    await until(() => page.scanTelegramCode(), 'a new QR code to scan');
    await until(() => page.workflow.step === 'signal', 'the Signal step');
    expect(page.workflow.telegram.instance).not.toBe(stopped);
    expect(browser.instances.has(stopped)).toBe(false);
    expect(page.workflow.notice).toBe("Telegram's library stopped after an internal error. (TDLib: Aborted())");
  });

  // Detects: "Disconnect and clear" waiting forever for a TDLib that stopped before it reported anything, with the
  // start page showing "Connecting" and nothing on the page to get out.
  it('finishes a clear when TDLib stops before reporting anything', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    first.workflow.goTo('packs');
    await until(() => first.workflow.telegram.state.kind === 'login', 'the login');
    await settle(first);
    browser.closePage();

    const second = await openPage(alice, browser, { silentTelegram: true });
    await until(() => second.workflow.telegram.state.kind === 'starting', 'TDLib starting');
    second.workflow.clear();
    // The clear reaches the wait for TDLib's first report before TDLib stops.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.workflow.state.kind).toBe('ending');
    second.started.at(-1)!.crash();
    await until(() => second.workflow.state.kind === 'setup', 'the start');
    await settle(second);
    expect(second.workflow.step).toBe('start');
    expect(browser.instances.size).toBe(0);
  });

  // Detects: the record of the earlier version not read after an update, which forgets the kept logins: the user
  // signs in and links again, and the old session and device stay active with nothing to end them.
  it('continues from the record kept by the earlier version', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    await link(first);
    first.workflow.setSelected(
      first.workflow.stickers!.entries.filter((entry) => entry.pack.title === 'B'),
      false,
    );
    const deviceId = deviceIdOf(first);
    await settle(first);
    browser.closePage();
    const kept = browser.snapshot as { telegram: string; signal: unknown; deselected: string[] };
    browser.snapshot = {
      version: 2,
      phase: 'setup',
      step: 'review',
      telegram: kept.telegram,
      signal: kept.signal,
      deselected: kept.deselected,
    };

    const second = await openPage(alice, browser);
    await until(() => second.workflow.step === 'review' && second.workflow.packsReady, 'the review');
    expect(deviceIdOf(second)).toBe(deviceId);
    expect(second.server.active.size).toBe(1);
    expect(world.signal.devices(alice.aci)).toEqual([1, deviceId]);
    expect(second.workflow.stickers!.entries.map((entry) => entry.selected)).toEqual([true, false]);
  });

  // Detects: going back to the start from the migration signing out or unlinking, the run going on in the
  // background, or a new start not continuing where the first one stopped.
  it('goes back to the start from the migration, signed in and linked, and continues on a new start', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 1, intervalMs: 72 * MINUTE } });
    const alice = world.user(['A', 'B', 'C'].map((title) => world.pack(title)));
    const page = await openPage(alice, new Browser());
    await signIn(page);
    await link(page);
    page.workflow.startMigration();
    await until(() => page.workflow.stickers?.uploadAllowedAt != null, 'the wait for the upload limit');
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(1);
    expect(page.workflow.goTo('start')).toBe(true);
    await settle(page);
    expect(page.workflow.state.kind === 'setup' && page.workflow.step).toBe('start');
    expect(page.workflow.telegram.state.kind).toBe('signed-in');
    expect(page.workflow.signal.state.kind).toBe('linked');
    await world.clock.advance(3 * 72 * MINUTE);
    await settle(page);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(1);

    page.workflow.goTo('review');
    await until(() => page.workflow.step === 'review' && page.workflow.packsReady, 'the review');
    await migrate(page);
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C']);
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
    page.workflow.clear();
    await until(() => page.workflow.state.kind === 'setup', 'the start');
    await settle(page);
    expect(page.workflow.step).toBe('start');
    expect(page.server.active.size).toBe(0);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
    expect(browser.instances.size).toBe(0);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a "Disconnect and clear" that could not unlink the device being forgotten: the next visit resumes the
  // device instead of finishing the clear, and its keys stay in the browser.
  it('finishes a "Disconnect and clear" that failed, at the next visit', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    await link(first);
    const deviceId = deviceIdOf(first);
    world.signal.failUnlinks = 1;
    first.workflow.clear();
    await until(() => first.workflow.state.kind === 'end-failed', 'the failed unlink');
    await settle(first);
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(true);
    browser.closePage();

    const second = await openPage(alice, browser);
    await until(() => !world.signal.isLinked(alice.aci, deviceId), 'the unlink');
    await settle(second);
    expect(second.workflow.step).toBe('start');
    expect(second.server.active.size).toBe(0);
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
    first.workflow.clear();
    await until(() => first.workflow.telegram.state.kind === 'signing-out', 'signing out');
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

    login.submit({ _: 'setAuthenticationPhoneNumber', phone_number: '+1 555 0100' });
    await until(
      () => login.state.kind === 'login' && login.state.auth._ === 'authorizationStateWaitCode' && !login.sending,
      'the code form',
    );
    login.submit({ _: 'checkAuthenticationCode', code: TelegramServer.CODE });
    await until(() => page.workflow.step === 'signal', 'the Signal step');
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
    page.devices.get(deviceIdOf(page))!.onUnlinked();
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
    await until(() => page.workflow.signal.state.kind === 'linking', 'linking');
    page.workflow.goTo('telegram');
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

  // Detects: packs installed only in the storage service, which the phone does not show: iOS installs packs only
  // from sync messages, and Android reads the storage only when told or once a day.
  it("tells the account's other devices about every pack it installs", async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    await world.migrateElsewhere(world.pack('B'));
    const page = await openPage(alice, new Browser());
    await signIn(page);
    await link(page);
    await migrate(page);
    const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const installed = (await alice.installedPacks()).map((pack) => `${hex(pack.packId)}:${hex(pack.packKey)}`);
    expect(installed).toHaveLength(3);
    expect(new Set(world.signal.toldInstalled.get(alice.aci))).toEqual(new Set(installed));
    expect(world.signal.toldToFetchStorage.get(alice.aci)).toBeGreaterThan(0);
  });

  // Detects: the migration finishing, and unlinking the device, before the other devices were told; afterwards
  // nothing could tell them any more.
  it('does not finish until the other devices were told', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser());
    await signIn(page);
    await link(page);
    world.signal.failAnnouncements = 1000;
    page.workflow.startMigration();
    await until(() => page.workflow.stickers?.announceError != null, 'the failure to tell the other devices');
    await settle(page);
    expect(page.workflow.state.kind).toBe('migrating');
    expect(page.workflow.signal.state.kind).toBe('linked');
    world.signal.failAnnouncements = 0;
    page.workflow.tryAgain();
    await until(() => page.workflow.state.kind === 'done', 'the end of the migration');
    expect(world.signal.toldInstalled.get(alice.aci)).toHaveLength(1);
  });

  // Detects: a reload after every pack reached Signal but before the phone was told ending the migration at once,
  // so that the phone is never told and shows none of the packs.
  it('tells the phone after a reload, before finishing, when every pack is already in Signal', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    await link(first);
    world.signal.failAnnouncements = 1000;
    first.workflow.goTo('review');
    first.workflow.startMigration();
    await until(() => first.workflow.stickers?.announceError != null, 'the failure to tell the other devices');
    await settle(first);
    browser.closePage();

    world.signal.failAnnouncements = 0;
    const second = await openPage(alice, browser);
    await until(() => second.workflow.state.kind === 'done', 'the end of the migration');
    expect(world.signal.toldInstalled.get(alice.aci)).toHaveLength(1);
  });

  // Detects: keeping a device linked by an earlier version, which has no keys to message the other devices, so that
  // the migration installs packs that never reach the phone.
  it('unlinks a device linked by an earlier version and asks to link again', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    await link(first);
    const deviceId = deviceIdOf(first);
    await settle(first);
    browser.closePage();
    const kept = browser.snapshot as { signal: Record<string, unknown> };
    for (const field of ['identityPublic', 'identityPrivate', 'registrationId']) delete kept.signal[field];

    const second = await openPage(alice, browser);
    await until(() => second.workflow.signal.error !== null, 'the request to link again');
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
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
