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
  photoFileId: 12,
};
const AIKO: Person = { userId: 6, givenName: 'Aiko', familyName: 'Tanaka', phoneNumber: '+447700900106' };
const JONAS: Person = { userId: 3, givenName: 'Jonas', familyName: '', phoneNumber: null };

/** Mara and Jonas in one-to-one chats, and a group with all three. Mara and the group have a picture. */
const people: PeopleSource = {
  readPhoto: (fileId) => Promise.resolve(Uint8Array.of(fileId)),
  readPeople: () =>
    Promise.resolve({
      chats: [
        { kind: 'person', userId: 2 },
        { kind: 'group', chatId: 100, title: 'Flat 12', memberIds: [2, 3, 6], memberCount: 3, photoFileId: 31 },
        { kind: 'person', userId: 3 },
      ],
      people: new Map([MARA, AIKO, JONAS].map((person) => [person.userId, person])),
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
  // Detects: the flow not reaching its end without sticker packs, friends not being written, an unticked friend
  // being added anyway, and the phone not being told.
  it('adds the ticked friends to the Signal contacts when friends are all the user chose', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser(), source().friendSource);
    page.workflow.choose('stickers', false);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
    expect(page.workflow.friends.kind).toBe('found');
    expect(page.workflow.friendsToAdd).toBe(2);

    page.workflow.tickFriends([AIKO.userId], false);
    expect(page.workflow.friendsToAdd).toBe(1);
    await migrate(page);

    expect(await contactNumbers(alice)).toEqual([MARA.phoneNumber]);
    expect(world.signal.toldToFetchStorage.get(alice.aci)).toBeGreaterThan(0);
    expect(page.workflow.friendsAdded).toBe(1);
  });

  // Detects: rows without the Telegram pictures by which a user recognises people and groups.
  it('reads the Telegram pictures of the people and groups it shows', async () => {
    const world = new StickerWorld();
    const page = await openPage(world.user([]), new Browser(), source().friendSource);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
    const pictures = () => {
      const friends = page.workflow.friends;
      return friends.kind === 'found' ? friends.photos : new Map<string, Uint8Array>();
    };
    await until(() => pictures().size === 2, 'the pictures');
    expect(pictures().get('user:2')).toEqual(Uint8Array.of(12));
    expect(pictures().get('chat:100')).toEqual(Uint8Array.of(31));
  });

  // Detects: one kind keeping the other from finishing, or the migration ending before both are done.
  it('moves sticker packs and friends in one migration', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = await openPage(alice, new Browser(), source().friendSource);
    page.workflow.choose('friends', true);
    await connectAndLook(page);
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
    expect(page.workflow.friendsToAdd).toBe(2);
  });

  // Detects: a reload forgetting what the user chose to move or whom they unticked.
  it('keeps the choice and the unticked friends over a reload', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const browser = new Browser();
    const first = await openPage(alice, browser, source().friendSource);
    first.workflow.choose('stickers', false);
    first.workflow.choose('friends', true);
    await connectAndLook(first);
    first.workflow.tickFriends([AIKO.userId], false);
    await first.workflow.settled();
    browser.closePage();

    const second = await openPage(alice, browser, source().friendSource);
    await until(() => second.workflow.friends.kind === 'found', 'the search after the reload');
    expect(second.workflow.chosen).toEqual({ stickers: false, friends: true });
    expect(second.workflow.friendsToAdd).toBe(1);
  });
});
