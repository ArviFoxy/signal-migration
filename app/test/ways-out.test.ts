// The ways out of the states in which the app used to wait forever. Each test drives the app, against the scenario
// world, into a state where Telegram, Signal or the browser's storage does not answer or fails, and checks that the
// app comes out of it within its time limit, with the approved message, and that the way it offers leads on.
// Time is faked, so that the one-minute limits pass at once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSession } from '../src/app/machine/app';
import { Workflow } from '../src/app/workflow';
import { appServices, Browser } from './scenario/stickers/app-services';
import { StickerWorld, type StickerUser } from './scenario/stickers/sticker-world';

const MINUTE = 60_000;

/** Lets the page's work run, in fake time, until `condition` holds. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (condition()) return;
    await vi.advanceTimersByTimeAsync(5);
  }
  throw new Error(`${what}: never happened`);
}

async function openPage(user: StickerUser, browser: Browser, options: Parameters<typeof appServices>[2] = {}) {
  const page = appServices(user, browser, options);
  const workflow = new Workflow(page.services);
  workflow.start();
  await until(() => isSession(workflow.state) || workflow.state.kind === 'load-failed', 'the page loaded');
  return { workflow, ...page };
}
type Page = Awaited<ReturnType<typeof openPage>>;

async function signIn(page: Page): Promise<void> {
  page.workflow.goTo('packs');
  await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
  await until(() => page.workflow.step === 'signal' && page.workflow.packsReady, 'the Signal step');
}

async function link(page: Page): Promise<void> {
  await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
  await until(() => page.workflow.step === 'packs' && page.workflow.packsReady, 'the packs');
}

/** The end that failed, as the "Not everything could be logged out" screen shows it. */
function endFailure(page: Page) {
  const state = page.workflow.state;
  return state.kind === 'end-failed' ? { telegram: state.telegramError, signal: state.signalError } : null;
}

/** A page closed during an unfinished login, which leaves its instance kept. */
async function keptUnfinishedLogin(user: StickerUser, browser: Browser): Promise<void> {
  const first = await openPage(user, browser);
  first.workflow.goTo('packs');
  await until(() => first.workflow.telegram.state.kind === 'login', 'the login');
  await first.workflow.settled();
  browser.closePage();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ways out', () => {
  // Detects: "Disconnect and clear" waiting forever for a kept TDLib instance that never reports whether it holds a
  // login (the start page with Telegram "Connecting" and every button disabled), also after a reload.
  it('ends a clear whose TDLib never reports, with "Forget it" leading back to the start', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    await keptUnfinishedLogin(alice, browser);
    const page = await openPage(alice, browser, { silentTelegram: true });
    page.workflow.clear();
    await vi.advanceTimersByTimeAsync(MINUTE + 1000);
    expect(endFailure(page)).toEqual({
      telegram: "Signing out of Telegram failed: Telegram's library did not start within 60 seconds.",
      signal: null,
    });
    page.workflow.forget('telegram');
    await until(() => page.workflow.state.kind === 'setup', 'the start');
    expect(page.workflow.step).toBe('start');
    expect(browser.instances.size).toBe(0);
  });

  // Detects: a clear waiting forever for a logout that Telegram never answers, and "Try again" not ending the
  // session once Telegram answers again.
  it('ends a clear whose logout is never answered, and signs out on "Try again"', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser, { logOutNever: true });
    await signIn(first);
    first.workflow.clear();
    await vi.advanceTimersByTimeAsync(MINUTE + 1000);
    expect(endFailure(first)).toEqual({
      telegram: 'Signing out of Telegram failed: Telegram did not answer within 60 seconds.',
      signal: null,
    });
    expect(first.server.active.size).toBe(1);
    // The next visit, with Telegram answering, finishes the clear.
    browser.closePage();
    const second = await openPage(alice, browser);
    await until(() => second.workflow.state.kind === 'setup', 'the start');
    expect(second.server.active.size).toBe(0);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: the end of the migration waiting forever for a logout that is never answered, with no way to finish.
  it('ends the finish whose logout is never answered, and finishes on "Forget it"', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser(), { logOutNever: true });
    await signIn(page);
    await link(page);
    page.workflow.goTo('review');
    page.workflow.startMigration();
    await until(() => page.workflow.state.kind === 'ending', 'the end of the migration');
    await vi.advanceTimersByTimeAsync(MINUTE + 1000);
    expect(endFailure(page)?.telegram).toBe(
      'Signing out of Telegram failed: Telegram did not answer within 60 seconds.',
    );
    page.workflow.forget('telegram');
    await until(() => page.workflow.state.kind === 'done', 'done');
    expect(await alice.installedTitles()).toEqual(['A']);
  });

  // Detects: a clear waiting forever for an unlink that Signal never answers, and Telegram not being signed out
  // meanwhile.
  it('ends a clear whose unlink is never answered, having signed out of Telegram', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser(), { unlinkNever: true });
    await signIn(page);
    await link(page);
    page.workflow.clear();
    await vi.advanceTimersByTimeAsync(MINUTE + 1000);
    expect(endFailure(page)).toEqual({
      telegram: null,
      signal: 'Unlinking Signal failed: Signal did not answer within 60 seconds.',
    });
    expect(page.server.active.size).toBe(0);
  });

  // Detects: "Try again" on "Not everything could be logged out" not ending what failed.
  it('ends what failed on "Try again"', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signIn(page);
    await link(page);
    const deviceId = page.workflow.signal.device!.deviceId;
    world.signal.failUnlinks = 1;
    page.workflow.clear();
    await until(() => page.workflow.state.kind === 'end-failed', 'the failed unlink');
    expect(endFailure(page)?.signal).toBe('Unlinking Signal failed: the connection to Signal closed');
    page.workflow.retryEnd();
    await until(() => page.workflow.state.kind === 'setup', 'the start');
    expect(world.signal.isLinked(alice.aci, deviceId)).toBe(false);
    expect(browser.snapshot).toBeNull();
  });

  // Detects: a kept login replaced by a new one after its start failed once ("Try again" signing in anew), which
  // leaves the old session active on Telegram with nothing to end it.
  it('continues the kept login on "Try again" after its start failed', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    const kept = first.workflow.telegram.instance;
    await first.workflow.settled();
    browser.closePage();
    const second = await openPage(alice, browser, { appFailures: 1 });
    await until(() => second.workflow.telegram.state.kind === 'stopped', 'the failed start');
    expect(second.workflow.telegram.error).toBe("reading the migration server's configuration answered 503");
    second.workflow.telegram.retry();
    await until(() => second.workflow.step === 'signal', 'the Signal step, without signing in again');
    expect(second.workflow.telegram.instance).toBe(kept);
    expect(second.server.active.size).toBe(1);
  });

  // Detects: a record that could not be read once taken for none, which forgets the kept logins and deletes their
  // data.
  it('offers "Try again" when the record cannot be read, and keeps the logins', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await signIn(first);
    await first.workflow.settled();
    browser.closePage();
    const second = await openPage(alice, browser, { loadFailures: 1 });
    const state = second.workflow.state;
    expect(state.kind === 'load-failed' && state.error).toBe(
      'Your browser could not read the saved migration: the database is blocked',
    );
    expect(browser.instances.size).toBe(1);
    second.workflow.retryLoad();
    await until(() => second.workflow.step === 'signal', 'the Signal step, without signing in again');
  });

  // Detects: TDLib starting on an instance that the browser could not record, which a reload would not know.
  it('does not start TDLib on an instance it could not record', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser(), { saveFails: true });
    page.workflow.goTo('packs');
    await until(() => page.workflow.telegram.error !== null, 'the error');
    expect(page.workflow.telegram.error).toBe(
      "This browser could not keep the migration's progress: the quota is exceeded",
    );
    expect(page.started).toHaveLength(0);
  });

  // Detects: a login forgotten and deleted when TDLib reports that it closed without a logout, while its session is
  // still active on Telegram.
  it('keeps a signed-in login when TDLib closes without a logout, and continues it on "Try again"', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const browser = new Browser();
    const page = await openPage(alice, browser);
    await signIn(page);
    const kept = page.workflow.telegram.instance;
    page.started.at(-1)!.report('authorizationStateClosing');
    await until(() => page.workflow.telegram.state.kind === 'stopped', 'the stopped login');
    expect(browser.instances.has(kept!)).toBe(true);
    page.workflow.telegram.retry();
    await until(() => page.workflow.step === 'signal', 'the Signal step, without signing in again');
    expect(page.workflow.telegram.instance).toBe(kept);
  });

  // Detects: signing out of Telegram during the migration leaving the run going, or a new login migrating its packs
  // without the user choosing them.
  it('stops the migration when the user signs out of Telegram, and goes back to the start', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 1, intervalMs: 72 * MINUTE } });
    const alice = world.user(['A', 'B', 'C'].map((title) => world.pack(title)));
    const page = await openPage(alice, new Browser());
    await signIn(page);
    await link(page);
    page.workflow.goTo('review');
    page.workflow.startMigration();
    await until(
      () => page.workflow.stickers?.entries.some((entry) => entry.state === 'in-signal') ?? false,
      'the first pack in Signal',
    );
    page.workflow.signOutOfTelegram();
    await until(() => page.workflow.telegram.state.kind === 'off', 'the sign-out');
    expect(page.workflow.state.kind).toBe('setup');
    expect(page.workflow.step).toBe('start');
    await world.clock.advance(3 * 72 * MINUTE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(1);
  });
});
