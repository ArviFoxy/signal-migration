// Scenarios of copying Saved Messages, driven through the workflow the way the user drives it, against the scenario
// world: simulated saved messages on the Telegram side, and a simulated Signal whose devices keep Note to Self as
// Signal's apps do: in the order of arrival, one message per timestamp. Each test names the failure it exists to
// catch.

import { describe, expect, it } from 'vitest';
import { isSession } from '../src/app/machine/app';
import { Workflow } from '../src/app/workflow';
import { noteOf, type SavedMessage } from '../src/kinds/saved/messages';
import type { SavedSource } from '../src/kinds/saved/telegram-saved';
import { AttachmentPointer_Flags, LONG_TEXT_CONTENT_TYPE, MAX_BODY_BYTES } from '../src/signal/note-to-self';
import { decryptAttachment } from '../src/wasm/signal_migration_wasm';
import { appServices, Browser } from './scenario/stickers/app-services';
import { type StickerUser, StickerWorld } from './scenario/stickers/sticker-world';
import './wasm';

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

const PHOTO_BYTES = new TextEncoder().encode('fake-jpeg-lake-photo-bytes');
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 simulated document bytes');
const LONG_TEXT = 'long-paragraph '.repeat(220); // > 2048 bytes, < 64 KiB
const MEDIA_FILES = new Map<number, Uint8Array>([
  [301, PHOTO_BYTES],
  [401, PDF_BYTES],
]);

/**
 * Nine messages, one per day: five short texts, a photo with a caption (3), a PDF file (4), a long text > 2 KiB (5),
 * and an oversized file > 100 MiB (9) that cannot fit Signal's upload limit.
 */
const MESSAGES: SavedMessage[] = [
  message(1),
  message(2),
  message(3, {
    kind: 'photo',
    body: 'at the lake',
    media: {
      fileId: 301,
      remoteId: 'r-301',
      size: PHOTO_BYTES.length,
      contentType: 'image/jpeg',
      width: 1280,
      height: 960,
    },
  }),
  message(4, {
    kind: 'file',
    body: '',
    media: {
      fileId: 401,
      remoteId: 'r-401',
      size: PDF_BYTES.length,
      contentType: 'application/pdf',
      fileName: 'receipt.pdf',
    },
  }),
  message(5, { body: LONG_TEXT }),
  message(6),
  message(7),
  message(8),
  message(9, {
    kind: 'file',
    body: '',
    media: {
      fileId: 901,
      remoteId: 'r-901',
      size: 110 * 1024 * 1024,
      contentType: 'application/zip',
      fileName: 'too-big.zip',
    },
  }),
];
const saved: SavedSource = {
  readMessages: () => Promise.resolve(MESSAGES),
  async withMedia(media, use) {
    const bytes = MEDIA_FILES.get(media.fileId);
    if (!bytes) throw new Error(`missing simulated file ${media.fileId}`);
    return use(bytes.length, async (onChunk) => {
      await onChunk(bytes);
    });
  },
};

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
  // Detects: messages before the chosen date being copied; photos, files, or long texts failing to encrypt, upload,
  // and decrypt cleanly on Signal; an order other than oldest first; or a message arriving under another date.
  it('copies text, photos, files, and long text from the chosen date on, oldest first, each with its date', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser());
    await connectAndRead(page);
    page.workflow.copySavedFrom(MESSAGES[1].date);
    expect(page.workflow.savedCopy).toEqual({
      toCopy: 7,
      copied: 0,
      withMedia: 2,
      mediaBytes: PHOTO_BYTES.length + PDF_BYTES.length,
      leftOut: { tooLarge: 1, other: 0 },
    });
    await startMigration(page);
    await until(() => page.workflow.state.kind === 'done', 'the end of the migration');

    const notes = world.signal.notesToSelf.get(alice.aci)!;
    expect(notes).toHaveLength(7);
    expect(notes.map((note) => Math.floor(note.timestamp / 1000))).toEqual(
      [2, 3, 4, 5, 6, 7, 8].map((number) => MESSAGES[number - 1].date),
    );
    expect(notes[0].body).toBe('note 2');

    // Photo with caption: uploaded to CDN 3, decrypts to exact JPEG bytes.
    expect(notes[1].body).toBe('at the lake');
    const photoPointer = notes[1].attachments![0];
    expect(photoPointer).toMatchObject({
      contentType: 'image/jpeg',
      width: 1280,
      height: 960,
      size: PHOTO_BYTES.length,
    });
    expect(
      decryptAttachment(
        world.signal.attachmentFile(photoPointer.cdnKey)!,
        photoPointer.key,
        photoPointer.digest,
        photoPointer.size,
      ),
    ).toEqual(PHOTO_BYTES);

    // Arbitrary PDF file: preserves fileName and contentType, decrypts to exact PDF bytes.
    expect(notes[2].body).toBe('');
    const pdfPointer = notes[2].attachments![0];
    expect(pdfPointer).toMatchObject({
      contentType: 'application/pdf',
      fileName: 'receipt.pdf',
      size: PDF_BYTES.length,
    });
    expect(
      decryptAttachment(
        world.signal.attachmentFile(pdfPointer.cdnKey)!,
        pdfPointer.key,
        pdfPointer.digest,
        pdfPointer.size,
      ),
    ).toEqual(PDF_BYTES);

    // Long text (> 2 KiB): trimmed inline body + full UTF-8 text in text/x-signal-plain attachment.
    expect(new TextEncoder().encode(notes[3].body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const longPointer = notes[3].attachments![0];
    expect(longPointer.contentType).toBe(LONG_TEXT_CONTENT_TYPE);
    const decryptedLong = new TextDecoder().decode(
      decryptAttachment(
        world.signal.attachmentFile(longPointer.cdnKey)!,
        longPointer.key,
        longPointer.digest,
        longPointer.size,
      ),
    );
    expect(decryptedLong).toBe(LONG_TEXT);

    expect(notes.slice(4).map((n) => n.body)).toEqual(['note 6', 'note 7', 'note 8']);
    expect(page.workflow.savedCopy).toMatchObject({ toCopy: 7, copied: 7 });
  });

  // Detects: the default cutoff failing to include all copyable messages, or a cutoff placed after the last message
  // still copying messages or letting a saved-only migration start with nothing to copy.
  it('starts with all messages selected, and copies nothing when the cutoff is past the last message', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = await openPage(alice, new Browser());
    await connectAndRead(page);
    expect(page.workflow.savedCopy).toEqual({
      toCopy: 8,
      copied: 0,
      withMedia: 2,
      mediaBytes: PHOTO_BYTES.length + PDF_BYTES.length,
      leftOut: { tooLarge: 1, other: 0 },
    });
    page.workflow.copySavedFrom(MESSAGES[MESSAGES.length - 1].date + 1);
    expect(page.workflow.savedCopy).toEqual({
      toCopy: 0,
      copied: 0,
      withMedia: 0,
      mediaBytes: 0,
      leftOut: { tooLarge: 0, other: 0 },
    });
    await startMigration(page);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.workflow.state.kind).toBe('setup');
    expect(bodiesIn(world, alice)).toEqual([]);
  });

  // Detects: Telegram albums (shared media_album_id) being split into separate bubbles, or voice/GIF flags being lost.
  it('groups Telegram albums into one Signal message and preserves voice/GIF flags', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const a1 = new TextEncoder().encode('album-photo-1');
    const a2 = new TextEncoder().encode('album-photo-2');
    const gifBytes = new TextEncoder().encode('gif-video-bytes');
    const voiceBytes = new TextEncoder().encode('ogg-opus-voice-bytes');
    const files = new Map<number, Uint8Array>([
      [1, a1],
      [2, a2],
      [3, gifBytes],
      [4, voiceBytes],
    ]);
    const albumMessages: SavedMessage[] = [
      message(1, {
        kind: 'photo',
        body: 'Vacation album',
        albumId: '999999',
        media: { fileId: 1, remoteId: 'r1', size: a1.length, contentType: 'image/jpeg', width: 800, height: 600 },
      }),
      message(2, {
        date: FIRST_DAY,
        kind: 'photo',
        body: '',
        albumId: '999999',
        media: { fileId: 2, remoteId: 'r2', size: a2.length, contentType: 'image/jpeg', width: 800, height: 600 },
      }),
      message(3, {
        kind: 'gif',
        body: '',
        media: { fileId: 3, remoteId: 'r3', size: gifBytes.length, contentType: 'video/mp4', gif: true },
      }),
      message(4, {
        kind: 'voice-note',
        body: '',
        media: {
          fileId: 4,
          remoteId: 'r4',
          size: voiceBytes.length,
          contentType: 'audio/ogg',
          duration: 12,
          voiceNote: true,
        },
      }),
    ];
    const albumSource: SavedSource = {
      readMessages: () => Promise.resolve(albumMessages),
      withMedia: (media, use) => {
        const bytes = files.get(media.fileId)!;
        return use(bytes.length, (onChunk) => onChunk(bytes));
      },
    };
    const page = appServices(alice, new Browser(), { saved: albumSource });
    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => isSession(workflow.state), 'the page loaded');
    await connectAndRead({ workflow, ...page });
    await startMigration({ workflow, ...page });
    await until(() => workflow.state.kind === 'done', 'album migration done');

    const notes = world.signal.notesToSelf.get(alice.aci)!;
    expect(notes).toHaveLength(3);
    expect(notes[0].body).toBe('Vacation album');
    expect(notes[0].attachments).toHaveLength(2);
    expect(
      notes[0].attachments!.map((a) =>
        decryptAttachment(world.signal.attachmentFile(a.cdnKey)!, a.key, a.digest, a.size),
      ),
    ).toEqual([a1, a2]);
    expect(notes[1].attachments![0].flags).toBe(AttachmentPointer_Flags.GIF);
    expect(notes[2].attachments![0].flags).toBe(AttachmentPointer_Flags.VOICE_MESSAGE);
    expect(notes[2].attachments![0].audioDurationSeconds).toBe(12);
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
    expect(world.signal.notesToSelf.get(alice.aci)!).toHaveLength(8);
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
    expect(world.signal.notesToSelf.get(alice.aci)!).toHaveLength(8);
    // The three messages sent before the reload are not sent again.
    expect(world.signal.notesSent.get(alice.aci)).toBe(8);
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
      withMedia: saved.withMedia,
    };
    const page = appServices(alice, browser, { saved: flakySaved });
    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => workflow.saved.kind === 'failed', 'the read to fail');
    expect(workflow.error).toContain('network blip');

    workflow.tryAgain();
    await until(() => workflow.state.kind === 'done', 'the migration to finish after retrying the read');
    expect(world.signal.notesToSelf.get(alice.aci)!).toHaveLength(8);
  });
});
