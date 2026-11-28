// Scenarios of finding friends, driven through the workflow the way the user drives it, against the scenario world:
// simulated people on the Telegram side, a simulated source of Signal accounts, and the simulated Signal service
// with its encrypted storage. Each test names the failure it exists to catch.

import { describe, expect, it } from 'vitest';
import { isSession } from '../src/app/machine/app';
import { Workflow } from '../src/app/workflow';
import type { FriendSource, SignalIdentifiers } from '../src/kinds/friends/search';
import type { PeopleSource, Person } from '../src/kinds/friends/telegram-people';
import { appServices, Browser } from './scenario/stickers/app-services';
import { type StickerUser, StickerWorld } from './scenario/stickers/sticker-world';

/** An ID in the form with hyphens, ending in `number`. */
const id = (number: number) => `${'0'.repeat(8)}-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;

const MARA: Person = {
  userId: 2,
  givenName: 'Mara',
  familyName: 'Lindqvist',
  phoneNumber: '+12025550102',
  photo: { run: 1, fileId: 12, remoteId: 'r-12' },
};
const AIKO: Person = {
  userId: 6,
  givenName: 'Aiko',
  familyName: 'Tanaka',
  phoneNumber: '+447700900106',
  photo: { run: 1, fileId: 16, remoteId: 'r-16' },
};
const JONAS: Person = { userId: 3, givenName: 'Jonas', familyName: '', phoneNumber: null };

/**
 * Mara and Jonas in one-to-one chats, and a group with Mara and Jonas. Aiko is in no chat and on the contact list.
 * Mara, Aiko and the group have a picture.
 */
const people: PeopleSource = {
  readPhoto: (photo) => Promise.resolve(Uint8Array.of(photo.fileId)),
  readPeople: () =>
    Promise.resolve({
      chats: [
        { kind: 'person', userId: 2 },
        {
          kind: 'group',
          chatId: 100,
          title: 'Flat 12',
          memberIds: [2, 3],
          memberCount: 2,
          photo: { run: 1, fileId: 31, remoteId: 'r-31' },
        },
        { kind: 'person', userId: 3 },
      ],
      people: new Map([MARA, AIKO, JONAS].map((person) => [person.userId, person])),
      contactIds: [AIKO.userId],
    }),
};

const signalOf = (person: Person): SignalIdentifiers => ({
  accountId: null,
  phoneNumberIdentity: id(person.userId),
  phoneNumber: person.phoneNumber,
});

/** A source that finds Mara and Aiko, counts how often it is asked, and fails the first `failures` times. */
function source(failures = 0) {
  const counts = { asked: 0 };
  const friendSource: FriendSource = {
    find() {
      counts.asked++;
      if (counts.asked <= failures) return Promise.reject(new Error('Signal did not answer'));
      return Promise.resolve(new Map([MARA, AIKO].map((person) => [person.userId, signalOf(person)])));
    },
  };
  return { friendSource, counts };
}

/** Waits until `condition` holds, letting the page's background work run. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`${what}: never happened`);
}

async function openPage(user: StickerUser, browser: Browser, friendSource: FriendSource) {
  const page = appServices(user, browser, { people, friendSources: [friendSource] });
  const workflow = new Workflow(page.services);
  workflow.start();
  await until(() => isSession(workflow.state), 'the page loaded');
  return { workflow, ...page };
}
type Page = Awaited<ReturnType<typeof openPage>>;

/** Connects both accounts on the way to the friends step and waits for the search to end. */
async function connectAndLook(page: Page): Promise<void> {
  page.workflow.goTo('friends');
  await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
  await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
  await until(() => page.workflow.step === 'friends' && page.workflow.friends.kind !== 'looking', 'the search');
}

async function migrate(page: Page): Promise<void> {
  page.workflow.goTo('review');
  await until(() => page.workflow.step === 'review' && page.workflow.ready, 'the review');
  page.workflow.startMigration();
  await until(() => page.workflow.state.kind === 'done', 'the end of the migration');
}

const contactNumbers = async (user: StickerUser) =>
  (await (await user.phone.storage()).readContacts()).contacts.map((contact) => contact.phoneNumber);

describe('finding friends', () => {
  // Detects: the flow not reaching its end without sticker packs, friends not being written, a friend the user
  // did not tick being added anyway, and the phone not being told.
  it('adds the ticked friends to the Signal contacts when friends are all the user chose', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser(), source().friendSource);
    page.workflow.choose('stickers', false);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
    expect(page.workflow.friends.kind).toBe('found');
    expect(page.workflow.friendsToAdd).toBe(0);

    page.workflow.tickFriends([MARA.userId, AIKO.userId], true);
    page.workflow.tickFriends([AIKO.userId], false);
    expect(page.workflow.friendsToAdd).toBe(1);
    await migrate(page);

    expect(await contactNumbers(alice)).toEqual([MARA.phoneNumber]);
    expect(world.signal.toldToFetchStorage.get(alice.aci)).toBeGreaterThan(0);
    expect(page.workflow.friendsAdded).toBe(1);
  });

  // Detects: rows without the Telegram pictures by which a user recognises people and groups, in the chats or on
  // the contact list.
  it('reads the Telegram pictures of the people and groups it shows', async () => {
    const world = new StickerWorld();
    const page = await openPage(world.user([]), new Browser(), source().friendSource);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
    const pictures = () => {
      const friends = page.workflow.friends;
      return friends.kind === 'found' ? friends.photos : new Map<string, Uint8Array>();
    };
    await until(() => pictures().size === 3, 'the pictures');
    expect(pictures().get('user:2')).toEqual(Uint8Array.of(12));
    expect(pictures().get('chat:100')).toEqual(Uint8Array.of(31));
    expect(pictures().get('user:6')).toEqual(Uint8Array.of(16));
  });

  // Detects: one kind keeping the other from finishing, or the migration ending before both are done.
  it('moves sticker packs and friends in one migration', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser(), source().friendSource);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
    page.workflow.tickFriends([MARA.userId, AIKO.userId], true);
    await migrate(page);

    expect((await contactNumbers(alice)).sort()).toEqual([MARA.phoneNumber, AIKO.phoneNumber].sort());
    expect(page.workflow.stickers!.selected.every((entry) => entry.state === 'in-signal')).toBe(true);
  });

  // Detects: phone numbers being sent to Signal although the user did not choose to look for friends.
  it('asks no source when the user did not choose friends', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const { friendSource, counts } = source();
    const page = await openPage(alice, new Browser(), friendSource);
    page.workflow.goTo('packs');
    await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
    await until(() => page.scanSignalCode(), 'a Signal QR code to scan');
    await until(() => page.workflow.step === 'packs' && page.workflow.packsReady, 'the packs');
    await migrate(page);

    expect(counts.asked).toBe(0);
    expect(await contactNumbers(alice)).toEqual([]);
  });

  // Detects: a failed search leaving the user stuck on the friends step.
  it('looks again after a failed search when the user tries again', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser(), source(1).friendSource);
    page.workflow.choose('stickers', false);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
    expect(page.workflow.friends.kind).toBe('failed');
    expect(page.workflow.error).toContain('Signal did not answer');

    page.workflow.tryAgain();
    await until(() => page.workflow.friends.kind === 'found', 'the second search');
    page.workflow.tickFriends([MARA.userId, AIKO.userId], true);
    expect(page.workflow.friendsToAdd).toBe(2);
  });

  // Detects: a reload forgetting what the user chose to move or whom they ticked.
  it('keeps the choice and the ticked friends over a reload', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const browser = new Browser();
    const first = await openPage(alice, browser, source().friendSource);
    first.workflow.choose('stickers', false);
    first.workflow.choose('friends', true);
    await connectAndLook(first);
    first.workflow.tickFriends([AIKO.userId], true);
    await first.workflow.settled();
    browser.closePage();

    const second = await openPage(alice, browser, source().friendSource);
    await until(() => second.workflow.friends.kind === 'found', 'the search after the reload');
    expect(second.workflow.chosen).toEqual({ stickers: false, friends: true, saved: false });
    expect(second.workflow.friendsToAdd).toBe(1);
  });

  // Detects: reopening during a multi-kind migration after Friends already finished re-scanning Telegram groups,
  // re-calling Signal contact discovery (burning CDSI quota / wedging on 4008), or resetting friendsAdded to 0.
  it('skips findFriends and Signal contact discovery on reopen once Friends already finished', async () => {
    const MINUTE = 60_000;
    const world = new StickerWorld({ uploadLimit: { burst: 1, intervalMs: 72 * MINUTE } });
    const alice = world.user([world.pack('A'), world.pack('B')]);
    const browser = new Browser();
    const first = appServices(alice, browser, {
      people,
      friendSources: [source().friendSource],
      leaveAfterWaitOf: 10 * MINUTE,
    });
    const w1 = new Workflow(first.services);
    w1.start();
    await until(() => isSession(w1.state), 'first page loaded');
    w1.choose('friends', true);
    w1.goTo('friends');
    await until(() => first.scanTelegramCode(), 'telegram qr');
    await until(() => first.scanSignalCode(), 'signal qr');
    await until(() => w1.friends.kind === 'found' && w1.packsReady, 'friends and packs ready');
    w1.tickFriends([MARA.userId], true);
    w1.goTo('review');
    await until(() => w1.step === 'review' && w1.ready, 'review ready');
    // Hold sticker pack A before listing until Friends finishes, so stickers' PageClosed cooldown
    // never aborts add-friends mid-flight on a slower runner.
    let friendsFinished!: () => void;
    const waitForFriends = new Promise<void>((resolve) => (friendsFinished = resolve));
    world.index.beforeAdd = () => waitForFriends;
    w1.startMigration();
    await until(() => w1.friendsAdded === 1, 'friends added');
    friendsFinished();
    world.index.beforeAdd = async () => undefined;
    await until(() => w1.error !== null, 'stickers hit cooldown');
    await w1.settled();
    browser.closePage();

    // On reopen, BOTH Telegram people scan and Signal CDSI would throw if called.
    let peopleReads = 0;
    let cdsiCalls = 0;
    const forbiddenPeople: PeopleSource = {
      readPeople: () => {
        peopleReads++;
        return Promise.reject(new Error('should not re-scan Telegram people after friends finished'));
      },
      readPhoto: () => Promise.reject(new Error('unused')),
    };
    const forbiddenCdsi: FriendSource = {
      find: () => {
        cdsiCalls++;
        return Promise.reject(new Error('CDSI allowance used up (4008)'));
      },
    };
    await world.clock.advance(2 * 72 * MINUTE);
    const second = appServices(alice, browser, { people: forbiddenPeople, friendSources: [forbiddenCdsi] });
    const w2 = new Workflow(second.services);
    w2.start();
    await until(() => w2.state.kind === 'done', 'migration finishes on reopen without re-running friends');

    expect(peopleReads).toBe(0);
    expect(cdsiCalls).toBe(0);
    expect(w2.friendsAdded).toBe(1);
    expect(await contactNumbers(alice)).toEqual([MARA.phoneNumber]);
    expect(await alice.installedTitles()).toEqual(['A', 'B']);
  });

  // Detects: closing the tab between storage.addContacts and announceStorageChange leaving other devices never told
  // on reopen because contactsToAdd filtered out the already-written contacts.
  it('announces Signal storage on reopen when contacts were written just before closing prior to announce', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const browser = new Browser();
    const first = await openPage(alice, browser, source().friendSource);
    first.workflow.choose('stickers', false);
    first.workflow.choose('friends', true);
    await connectAndLook(first);
    first.workflow.tickFriends([MARA.userId], true);
    first.workflow.goTo('review');
    await until(() => first.workflow.step === 'review' && first.workflow.ready, 'review ready');

    // Storage write succeeds, then announceStorageChange fails right before the tab closes.
    world.signal.failAnnouncements = 1;
    first.workflow.startMigration();
    await until(() => first.workflow.runFailed, 'announce fails');
    await first.workflow.settled();
    expect(await contactNumbers(alice)).toEqual([MARA.phoneNumber]);
    expect(world.signal.toldToFetchStorage.get(alice.aci) ?? 0).toBe(0);
    expect((browser.snapshot as { friendsAdded: unknown }).friendsAdded).toBeNull();
    browser.closePage();

    const second = await openPage(alice, browser, source().friendSource);
    await until(() => second.workflow.state.kind === 'done', 'reopen announces storage and finishes');
    expect(world.signal.toldToFetchStorage.get(alice.aci)).toBeGreaterThan(0);
    expect(second.workflow.friendsAdded).toBe(1);
  });

  // Detects: ticking an additional friend after going Back to start keeping the stale friendsAdded marker and
  // skipping the newly ticked friend on the second start.
  it('resets friendsAdded when the user goes back and ticks another friend', async () => {
    const MINUTE = 60_000;
    const world = new StickerWorld({ uploadLimit: { burst: 1, intervalMs: 72 * MINUTE } });
    const alice = world.user([world.pack('A'), world.pack('B')]);
    const browser = new Browser();
    const page = appServices(alice, browser, {
      people,
      friendSources: [source().friendSource],
      leaveAfterWaitOf: 10 * MINUTE,
    });
    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => isSession(workflow.state), 'loaded');
    workflow.choose('friends', true);
    workflow.goTo('friends');
    await until(() => page.scanTelegramCode(), 'telegram qr');
    await until(() => page.scanSignalCode(), 'signal qr');
    await until(() => workflow.friends.kind === 'found' && workflow.packsReady, 'ready');
    workflow.tickFriends([MARA.userId], true);
    workflow.goTo('review');
    await until(() => workflow.step === 'review' && workflow.ready, 'review ready');
    // Hold sticker pack A before listing until Mara is added, so stickers' PageClosed cooldown
    // never aborts add-friends mid-flight on a slower runner.
    let friendsFinished!: () => void;
    const waitForFriends = new Promise<void>((resolve) => (friendsFinished = resolve));
    world.index.beforeAdd = () => waitForFriends;
    workflow.startMigration();
    await until(() => workflow.friendsAdded === 1, 'Mara added');
    friendsFinished();
    world.index.beforeAdd = async () => undefined;
    await until(() => workflow.error !== null, 'stickers paused');
    expect(await contactNumbers(alice)).toEqual([MARA.phoneNumber]);

    // Go back, tick Aiko too, and finish once cooldown has elapsed.
    workflow.goTo('friends');
    await until(() => workflow.step === 'friends', 'back on friends step');
    workflow.tickFriends([AIKO.userId], true);
    expect(workflow.friendsAdded).toBeNull();
    await world.clock.advance(2 * 72 * MINUTE);
    workflow.goTo('review');
    await until(() => workflow.step === 'review' && workflow.ready, 'review ready');
    workflow.startMigration();
    await until(() => workflow.state.kind === 'done', 'finished with both friends');
    expect((await contactNumbers(alice)).sort()).toEqual([MARA.phoneNumber, AIKO.phoneNumber].sort());
  });
});
