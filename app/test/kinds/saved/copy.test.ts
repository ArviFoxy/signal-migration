// Copying Saved Messages into Note to Self (kinds/saved/copy.ts): verifies that unknown-size oversized media and
// unconvertible stickers are skipped (advancing onSent) instead of permanently wedging migration progress.

import { describe, expect, it } from 'vitest';
import { copyToNoteToSelf } from '../../../src/kinds/saved/copy';
import type { SavedMessage } from '../../../src/kinds/saved/messages';
import type { SavedSource } from '../../../src/kinds/saved/telegram-saved';
import { ConversionError } from '../../../src/kinds/stickers/convert';
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '../../../src/signal/attachment';
import type { Note } from '../../../src/signal/note-to-self';
import type { SignalAccount } from '../../../src/signal/transport';
import '../../wasm';

function fakeAccount() {
  const sent: Note[] = [];
  const account: Pick<SignalAccount, 'withChat' | 'https' | 'sendNoteToSelf'> = {
    withChat: async () => {
      throw new Error('should not request upload form for skipped oversized/unconvertible attachment');
    },
    https: async () => {
      throw new Error('should not upload skipped attachment');
    },
    async sendNoteToSelf(note) {
      sent.push(note);
    },
  };
  return { account, sent };
}

describe('copyToNoteToSelf error resilience', () => {
  // Detects: an unknown-size media file (media.size === 0) that turns out larger than Signal's 100 MiB encrypted
  // limit after downloading causing copyToNoteToSelf to fail before onSent and wedge every future retry.
  it('skips unknown-size media exceeding Signal limit after download and continues with later messages', async () => {
    const { account, sent } = fakeAccount();
    const messages: SavedMessage[] = [
      {
        id: 10,
        date: 1_700_000_001,
        kind: 'video',
        body: 'huge unknown size',
        styles: [],
        media: {
          file: { run: 1, fileId: 1, remoteId: 'r1' },
          size: 0,
          contentType: 'video/mp4',
        },
      },
      {
        id: 20,
        date: 1_700_000_002,
        kind: 'text',
        body: 'after huge video',
        styles: [],
      },
    ];
    const source: SavedSource = {
      readMessages: async () => messages,
      withMedia: async (_media, use) => use(MAX_ATTACHMENT_UPLOAD_BYTES, async () => undefined),
    };
    const sentIds: number[] = [];
    await copyToNoteToSelf(account, messages, (id) => sentIds.push(id), new AbortController().signal, { source });
    expect(sentIds).toEqual([10, 20]);
    expect(sent.map((n) => n.body)).toEqual(['after huge video']);
  });

  // Detects: a single corrupted/unconvertible animated sticker throwing ConversionError and permanently wedging
  // Saved Messages migration before all subsequent messages.
  it('skips a sticker that fails conversion with ConversionError and continues with later messages', async () => {
    const { account, sent } = fakeAccount();
    const messages: SavedMessage[] = [
      {
        id: 10,
        date: 1_700_000_001,
        kind: 'sticker',
        body: '',
        styles: [],
        media: {
          file: { run: 1, fileId: 1, remoteId: 'r1' },
          size: 16,
          contentType: 'application/x-tgsticker',
          stickerFormat: 'tgs',
          borderless: true,
        },
      },
      {
        id: 20,
        date: 1_700_000_002,
        kind: 'text',
        body: 'after broken sticker',
        styles: [],
      },
    ];
    const source: SavedSource = {
      readMessages: async () => messages,
      withMedia: async (_media, use) => use(4, async (onChunk) => onChunk(new Uint8Array([1, 2, 3, 4]))),
    };
    const sentIds: number[] = [];
    await copyToNoteToSelf(account, messages, (id) => sentIds.push(id), new AbortController().signal, {
      source,
      convert: async () => {
        throw new ConversionError('corrupt sticker');
      },
    });
    expect(sentIds).toEqual([10, 20]);
    expect(sent.map((n) => n.body)).toEqual(['after broken sticker']);
  });

  // Detects: copyToNoteToSelf omitting messageId when calling source.withMedia (breaking post-restart file_reference
  // refresh) or failing to forward cancel/onWait to sendNoteToSelf.
  it('passes item.id to source.withMedia and forwards cancel/onWait to sendNoteToSelf', async () => {
    const withMediaCalls: unknown[] = [];
    const sendNoteOptions: unknown[] = [];
    const controller = new AbortController();
    const account: Pick<SignalAccount, 'withChat' | 'https' | 'sendNoteToSelf'> = {
      withChat: async (action) =>
        action({
          async request() {
            return {
              status: 200,
              message: 'OK',
              headers: [],
              body: new TextEncoder().encode(
                JSON.stringify({
                  cdn: 3,
                  key: 'k1',
                  headers: {},
                  signedUploadLocation: 'https://cdn3.signal.org/attachments/',
                }),
              ),
            };
          },
        }),
      https: async () => ({ status: 204, header: () => undefined, body: new Uint8Array() }),
      async sendNoteToSelf(_note, ...rest: unknown[]) {
        sendNoteOptions.push(rest[0]);
      },
    };
    const messages: SavedMessage[] = [
      {
        id: 42 * 2 ** 20,
        date: 1_700_000_001,
        kind: 'file',
        body: 'doc',
        styles: [],
        media: {
          file: { run: 1, fileId: 1, remoteId: 'r1' },
          size: 4,
          contentType: 'application/octet-stream',
        },
      },
    ];
    const source: SavedSource = {
      readMessages: async () => messages,
      withMedia: async (_media, use, _cancel, ...rest: unknown[]) => {
        withMediaCalls.push(rest[0]);
        return use(4, async (onChunk) => onChunk(new Uint8Array([1, 2, 3, 4])));
      },
    };
    await copyToNoteToSelf(account, messages, () => undefined, controller.signal, {
      source,
      onWait: () => undefined,
    });
    expect(withMediaCalls[0]).toMatchObject({ messageId: 42 * 2 ** 20 });
    expect(sendNoteOptions[0]).toMatchObject({ cancel: controller.signal });
  });
});
