// Scenarios of copying Saved Messages, driven through the workflow the way the user drives it, against the scenario
// world: simulated saved messages on the Telegram side, and a simulated Signal whose devices keep Note to Self as
// Signal's apps do: in the order of arrival, one message per timestamp. Each test names the failure it exists to
// catch.

import { describe, expect, it } from 'vitest';
import { isSession } from '../src/app/machine/app';
import { Workflow } from '../src/app/workflow';
import { noteOf, type SavedMessage } from '../src/kinds/saved/messages';
import type { SavedSource } from '../src/kinds/saved/telegram-saved';
import { appServices, Browser } from './scenario/stickers/app-services';
import { type StickerUser, StickerWorld } from './scenario/stickers/sticker-world';

const DAY = 86_400;
/** 1 March 2022, 12:00 UTC. */
const FIRST_DAY = Date.UTC(2022, 2, 1, 12) / 1000;

const message = (number: number, parts: Partial<SavedMessage> = {}): SavedMessage => ({
  id: number * 2 ** 20,
  date: FIRST_DAY + (number - 1) * DAY,
  kind: 'text',
  body: `note ${number}`,
  styles: [],
  ...parts,
});

/**
 * Eight messages, one per day: six texts, a photo with a caption (3) and a text too long for one Signal message
 * (5).
 */
const MESSAGES: SavedMessage[] = [
  message(1),
  message(2),
  message(3, { kind: 'photo', body: 'at the lake' }),
  message(4),
  message(5, { body: 'a'.repeat(3000) }),
  message(6),
  message(7),
  message(8),
];
const saved: SavedSource = { readMessages: () => Promise.resolve(MESSAGES) };

/** Waits until `condition` holds, letting the page's background work run. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`${what}: never happened`);
}

async function openPage(user: StickerUser, browser: Browser) {
  const page = appServices(user, browser, { saved });
  const workflow = new Workflow(page.services);
  workflow.start();
  await until(() => isSession(workflow.state), 'the page loaded');
  return { workflow, ...page };
}
type Page = Awaited<ReturnType<typeof openPage>>;

/** Chooses saved messages alone, connects both accounts and waits for the messages to be read. */
async function connectAndRead(page: Page): Promise<void> {
  page.workflow.choose('stickers', false);
  page.workflow.choose('saved', true);
  page.workflow.goTo('saved');
  await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
  await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
  await until(() => page.workflow.step === 'saved' && page.workflow.saved.kind === 'read', 'the saved messages');
}

async function startMigration(page: Page): Promise<void> {
  page.workflow.goTo('review');
  await until(() => page.workflow.step === 'review' && page.workflow.ready, 'the review');
  page.workflow.startMigration();
}

const bodiesIn = (world: StickerWorld, user: StickerUser) =>
  (world.signal.notesToSelf.get(user.aci) ?? []).map((note) => note.body);

describe('copying Saved Messages', () => {
  // Detects: messages before the chosen date being copied; a photo's caption or an over-long text being sent as a
  // message; an order other than oldest first, which is the order Signal's apps then show; and a message arriving
  // under another date than its own.
  it('copies the text messages from the chosen date on, oldest first, each with its date', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser());
    await connectAndRead(page);
    page.workflow.copySavedFrom(MESSAGES[1].date);
    expect(page.workflow.savedCopy).toEqual({ toCopy: 5, copied: 0, leftOut: { media: 1, tooLong: 1, other: 0 } });
    await startMigration(page);
    await until(() => page.workflow.state.kind === 'done', 'the end of the migration');

    expect(bodiesIn(world, alice)).toEqual(['note 2', 'note 4', 'note 6', 'note 7', 'note 8']);
    const notes = world.signal.notesToSelf.get(alice.aci)!;
    expect(notes.map((note) => Math.floor(note.timestamp / 1000))).toEqual(
      [2, 4, 6, 7, 8].map((number) => MESSAGES[number - 1].date),
    );
    expect(page.workflow.savedCopy).toMatchObject({ toCopy: 5, copied: 5 });
  });

  // Detects: the default cutoff failing to include all messages, or a cutoff placed after the last message still
  // copying messages or letting a saved-only migration start with nothing to copy.
  it('starts with all messages selected, and copies nothing when the cutoff is past the last message', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser());
    await connectAndRead(page);
    expect(page.workflow.savedCopy).toEqual({ toCopy: 6, copied: 0, leftOut: { media: 1, tooLong: 1, other: 0 } });
    page.workflow.copySavedFrom(MESSAGES[MESSAGES.length - 1].date + 1);
    expect(page.workflow.savedCopy).toEqual({ toCopy: 0, copied: 0, leftOut: { media: 0, tooLong: 0, other: 0 } });
    await startMigration(page);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.workflow.state.kind).toBe('setup');
    expect(bodiesIn(world, alice)).toEqual([]);
  });

  // Detects: a run that stopped midway starting over and showing messages twice, or leaving some out, or putting
  // them out of order, when the user tries again.
  it('continues after a failure, without repeating or losing a message', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser());
    await connectAndRead(page);
    page.workflow.copySavedFrom(MESSAGES[0].date);
    world.signal.failNotesAfter = 2;
    await startMigration(page);
    await until(() => page.workflow.runFailed, 'the run to fail');
    expect(page.workflow.error).toContain('Copying your Saved Messages to Signal failed');
    expect(bodiesIn(world, alice)).toEqual(['note 1', 'note 2']);

    world.signal.failNotesAfter = null;
    page.workflow.tryAgain();
    await until(() => page.workflow.state.kind === 'done', 'the end of the migration');
    expect(bodiesIn(world, alice)).toEqual(['note 1', 'note 2', 'note 4', 'note 6', 'note 7', 'note 8']);
  });

  // Detects: a reload during the migration forgetting the chosen date or how far the run was, so that the
  // migration does not finish, or starts again from the first message.
  it('continues where it stopped after a reload', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await connectAndRead(first);
    first.workflow.copySavedFrom(MESSAGES[0].date);
    world.signal.failNotesAfter = 3;
    await startMigration(first);
    await until(() => first.workflow.runFailed, 'the run to stop');
    await first.workflow.settled();
    browser.closePage();
    const sentBefore = world.signal.notesSent.get(alice.aci);
    expect(sentBefore).toBe(3);

    world.signal.failNotesAfter = null;
    const second = await openPage(alice, browser);
    await until(() => second.workflow.state.kind === 'done', 'the end of the migration');
    expect(bodiesIn(world, alice)).toEqual(['note 1', 'note 2', 'note 4', 'note 6', 'note 7', 'note 8']);
    // The three messages sent before the reload are not sent again.
    expect(world.signal.notesSent.get(alice.aci)).toBe(6);
  });

  // Detects: a second migration of the same account doubling the messages in Note to Self. The app keeps nothing
  // after a migration, so the second one sends them again; they must carry the same timestamps, by which Signal's
  // apps drop them.
  it('shows no message twice when the migration is run a second time', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    for (const _run of [1, 2]) {
      const page = await openPage(alice, new Browser());
      await connectAndRead(page);
      page.workflow.copySavedFrom(MESSAGES[5].date);
      await startMigration(page);
      await until(() => page.workflow.state.kind === 'done', 'the end of the migration');
    }
    expect(bodiesIn(world, alice)).toEqual(['note 6', 'note 7', 'note 8']);
    expect(world.signal.notesSent.get(alice.aci)).toBe(6);
    expect(world.signal.notesToSelf.get(alice.aci)!.map((note) => note.timestamp)).toEqual(
      [6, 7, 8].map((number) => noteOf(MESSAGES[number - 1]).timestamp),
    );
  });

  // Detects: one kind keeping the other from finishing, or the migration ending before both are done.
  it('moves sticker packs and saved messages in one migration', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser());
    page.workflow.choose('saved', true);
    page.workflow.goTo('saved');
    await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
    await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
    await until(() => page.workflow.saved.kind === 'read' && page.workflow.packsReady, 'the packs and the messages');
    page.workflow.copySavedFrom(MESSAGES[6].date);
    await startMigration(page);
    await until(() => page.workflow.state.kind === 'done', 'the end of the migration');

    expect(bodiesIn(world, alice)).toEqual(['note 7', 'note 8']);
    expect(page.workflow.stickers!.selected.every((entry) => entry.state === 'in-signal')).toBe(true);
  });

  // Detects: the messages being read from Telegram although the user did not choose them.
  it('does not read the messages when the user did not choose them', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    let reads = 0;
    const page = appServices(alice, new Browser(), {
      saved: { readMessages: () => (reads++, Promise.resolve(MESSAGES)) },
    });
    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => isSession(workflow.state), 'the page loaded');
    workflow.goTo('packs');
    await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
    await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
    await until(() => workflow.step === 'packs' && workflow.packsReady, 'the packs');
    expect(reads).toBe(0);
    expect(workflow.saved.kind).toBe('none');
  });

  // Detects: "Try again" doing nothing when re-reading Saved Messages fails after reloading mid-migration.
  it('retries reading Saved Messages when a reload mid-migration fails to read them', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const browser = new Browser();
    const first = await openPage(alice, browser);
    await connectAndRead(first);
    world.signal.failNotesAfter = 2;
    await startMigration(first);
    await until(() => first.workflow.runFailed, 'the run to stop');
    await first.workflow.settled();
    browser.closePage();

    world.signal.failNotesAfter = null;
    let failRead = true;
    const flakySaved: SavedSource = {
      readMessages: () =>
        failRead ? ((failRead = false), Promise.reject(new Error('network blip'))) : Promise.resolve(MESSAGES),
    };
    const page = appServices(alice, browser, { saved: flakySaved });
    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => workflow.saved.kind === 'failed', 'the read to fail');
    expect(workflow.error).toContain('network blip');

    workflow.tryAgain();
    await until(() => workflow.state.kind === 'done', 'the migration to finish after retrying the read');
    expect(bodiesIn(world, alice)).toEqual(['note 1', 'note 2', 'note 4', 'note 6', 'note 7', 'note 8']);
  });
});
