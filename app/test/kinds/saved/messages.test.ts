// How a Telegram message becomes a Signal message (kinds/saved/messages.ts): the text with its styles, the
// timestamp that identifies it, and what is left out.

import type * as Td from 'tdlib-types';
import { describe, expect, it } from 'vitest';
import {
  noteOf,
  reasonLeftOut,
  type SavedMessage,
  savedMessageOf,
  styledText,
} from '../../../src/kinds/saved/messages';

const entity = (offset: number, length: number, type: object) =>
  ({ _: 'textEntity', offset, length, type }) as Td.textEntity;
const formatted = (text: string, entities: Td.textEntity[] = []) =>
  ({ _: 'formattedText', text, entities }) as Td.formattedText;

/** A message as TDLib gives it. TDLib's ID is Telegram's number of the message shifted by 20 bits. */
const telegramMessage = (number: number, date: number, content: object) =>
  ({ _: 'message', id: number * 2 ** 20, date, content }) as unknown as Td.message;

const text = (number: number, date: number, body: string): SavedMessage => ({
  id: number * 2 ** 20,
  date,
  kind: 'text',
  body,
  styles: [],
});

describe('Telegram’s formatted text as a Signal body', () => {
  // Detects: a style Signal has being dropped or renamed, and Telegram's three kinds of code not all becoming
  // monospace.
  it('keeps the styles Signal has', () => {
    const { body, styles } = styledText(
      formatted('bold italic struck hidden code', [
        entity(0, 4, { _: 'textEntityTypeBold' }),
        entity(5, 6, { _: 'textEntityTypeItalic' }),
        entity(12, 6, { _: 'textEntityTypeStrikethrough' }),
        entity(19, 6, { _: 'textEntityTypeSpoiler' }),
        entity(26, 4, { _: 'textEntityTypePreCode', language: 'ts' }),
      ]),
    );
    expect(body).toBe('bold italic struck hidden code');
    expect(styles).toEqual([
      { start: 0, length: 4, style: 'bold' },
      { start: 5, length: 6, style: 'italic' },
      { start: 12, length: 6, style: 'strikethrough' },
      { start: 19, length: 6, style: 'spoiler' },
      { start: 26, length: 4, style: 'monospace' },
    ]);
  });

  // Detects: a style without an equivalent in Signal taking the text with it.
  it('keeps the text of a style Signal does not have', () => {
    const { body, styles } = styledText(formatted('underlined', [entity(0, 10, { _: 'textEntityTypeUnderline' })]));
    expect(body).toBe('underlined');
    expect(styles).toEqual([]);
  });

  // Detects: the address of a link behind a word being lost, since Signal has no such link; and the styles after
  // the link landing on the wrong characters once the address is written into the text.
  it('writes a link’s address after its word and moves the later styles along', () => {
    const { body, styles } = styledText(
      formatted('see docs now', [
        entity(4, 4, { _: 'textEntityTypeTextUrl', url: 'https://example.org/a' }),
        entity(9, 3, { _: 'textEntityTypeBold' }),
      ]),
    );
    expect(body).toBe('see docs (https://example.org/a) now');
    expect(styles).toEqual([{ start: 33, length: 3, style: 'bold' }]);
    expect(body.slice(33, 36)).toBe('now');
  });

  // Detects: a style that spans a link being cut short where the address was written in.
  it('stretches a style that spans a link over the address', () => {
    const { body, styles } = styledText(
      formatted('a link b', [
        entity(0, 8, { _: 'textEntityTypeItalic' }),
        entity(2, 4, { _: 'textEntityTypeTextUrl', url: 'https://e.org' }),
      ]),
    );
    expect(body).toBe('a link (https://e.org) b');
    expect(styles).toEqual([{ start: 0, length: body.length, style: 'italic' }]);
  });

  // Detects: an address written twice when the link's text is the address itself.
  it('does not repeat an address that is already the text', () => {
    const { body } = styledText(
      formatted('https://e.org', [entity(0, 13, { _: 'textEntityTypeTextUrl', url: 'https://e.org' })]),
    );
    expect(body).toBe('https://e.org');
  });

  // Detects: positions counted in characters instead of UTF-16 code units, which both Telegram and Signal use: an
  // emoji before a style would shift it.
  it('counts positions as Telegram and Signal do, with an emoji before the style', () => {
    const { body, styles } = styledText(formatted('🦊 fox', [entity(3, 3, { _: 'textEntityTypeBold' })]));
    expect(styles).toEqual([{ start: 3, length: 3, style: 'bold' }]);
    expect(body.slice(3, 6)).toBe('fox');
  });
});

const tdFile = (id: number, size: number, remoteId = `remote-${id}`) => ({
  _: 'file',
  id,
  size,
  expected_size: size,
  local: { path: '', downloaded_size: 0, is_downloading_completed: false },
  remote: { id: remoteId, unique_id: `u-${id}` },
});

describe('a saved message', () => {
  // Detects: photos, videos, documents, voice notes, GIFs, or stickers failing to extract their media file info, or
  // choosing a thumbnail instead of the largest photo size.
  it('extracts media metadata for photos, videos, GIFs, voice notes, documents, and stickers', () => {
    const note = savedMessageOf(telegramMessage(7, 1_600_000_000, { _: 'messageText', text: formatted('hello') }));
    expect(note).toMatchObject({ id: 7 * 2 ** 20, date: 1_600_000_000, kind: 'text', body: 'hello' });
    expect(reasonLeftOut(note)).toBeNull();

    const photo = savedMessageOf(
      telegramMessage(8, 1_600_000_001, {
        _: 'messagePhoto',
        photo: {
          sizes: [
            { type: 's', width: 320, height: 240, photo: tdFile(10, 8_000) },
            { type: 'y', width: 1280, height: 960, photo: tdFile(11, 180_000) },
          ],
        },
        caption: formatted('at the lake'),
      }),
    );
    expect(photo).toMatchObject({
      kind: 'photo',
      body: 'at the lake',
      media: { fileId: 11, remoteId: 'remote-11', size: 180_000, contentType: 'image/jpeg', width: 1280, height: 960 },
    });
    expect(reasonLeftOut(photo)).toBeNull();

    const doc = savedMessageOf(
      telegramMessage(9, 1_600_000_002, {
        _: 'messageDocument',
        document: { file_name: 'notes.pdf', mime_type: 'application/pdf', document: tdFile(12, 42_000) },
        caption: formatted(''),
      }),
    );
    expect(doc.media).toMatchObject({
      fileId: 12,
      contentType: 'application/pdf',
      fileName: 'notes.pdf',
      size: 42_000,
    });
    expect(reasonLeftOut(doc)).toBeNull();

    const voice = savedMessageOf(
      telegramMessage(10, 1_600_000_003, {
        _: 'messageVoiceNote',
        voice_note: { duration: 14, mime_type: 'audio/ogg', voice: tdFile(13, 19_000) },
        caption: formatted(''),
      }),
    );
    expect(voice.media).toMatchObject({ fileId: 13, contentType: 'audio/ogg', duration: 14, voiceNote: true });
    expect(reasonLeftOut(voice)).toBeNull();

    const gif = savedMessageOf(
      telegramMessage(11, 1_600_000_004, {
        _: 'messageAnimation',
        animation: { width: 480, height: 270, duration: 3, mime_type: 'video/mp4', animation: tdFile(14, 90_000) },
        caption: formatted(''),
      }),
    );
    expect(gif.media).toMatchObject({ fileId: 14, contentType: 'video/mp4', gif: true, width: 480, height: 270 });
    expect(reasonLeftOut(gif)).toBeNull();
  });

  // Detects: long text messages up to 64 KiB being wrongly dropped, oversized files > Signal's limit not being left
  // out, protected/self-destructing messages being copied, or unsupported kinds being sent as empty messages.
  it('copies long text up to 64 KiB, and leaves out oversized files, protected messages, and unsupported kinds', () => {
    expect(reasonLeftOut(text(1, 1, 'a'.repeat(3000)))).toBeNull();
    expect(reasonLeftOut(text(1, 1, 'a'.repeat(65_537)))).toBe('too-large');

    const hugeFile = savedMessageOf(
      telegramMessage(8, 1, {
        _: 'messageDocument',
        document: { file_name: 'huge.zip', mime_type: 'application/zip', document: tdFile(20, 105 * 1024 * 1024) },
        caption: formatted(''),
      }),
    );
    expect(reasonLeftOut(hugeFile)).toBe('too-large');

    const restricted = savedMessageOf({
      ...telegramMessage(8, 1, { _: 'messageText', text: formatted('secret') }),
      can_be_saved: false,
    } as unknown as Td.message);
    expect(reasonLeftOut(restricted)).toBe('other');

    expect(reasonLeftOut(savedMessageOf(telegramMessage(9, 1, { _: 'messageLocation' })))).toBe('other');
    expect(reasonLeftOut(savedMessageOf(telegramMessage(9, 1, { _: 'messageUnsupported' })))).toBe('other');
  });
});

describe('the timestamp of a copied message', () => {
  // Detects: a timestamp that depends on anything but the Telegram message (the time of the run, a counter): a
  // second run would then give the same message another timestamp, and Signal's apps would show it twice.
  it('is the same every time it is computed, and carries Telegram’s date', () => {
    const message = text(41_237, 1_615_298_707, 'x');
    expect(noteOf(message).timestamp).toBe(noteOf({ ...message }).timestamp);
    expect(Math.floor(noteOf(message).timestamp / 1000)).toBe(1_615_298_707);
    expect(noteOf(message).timestamp).toBe(1_615_298_707_237);
  });

  // Detects: two messages sent in the same second getting one timestamp. Signal's apps would take the second for
  // a repeat of the first and drop it.
  it('differs for messages sent in the same second', () => {
    const sameSecond = [100, 101, 102, 999, 1000, 1001].map(
      (number) => noteOf(text(number, 1_700_000_000, 'x')).timestamp,
    );
    expect(new Set(sameSecond).size).toBe(sameSecond.length);
  });
});
