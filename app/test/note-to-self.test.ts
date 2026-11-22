// The message that puts a note into Signal's Note to Self (signal/note-to-self.ts), checked against what Signal's
// apps require of a sent transcript: Signal-Android's EnvelopeContentValidator (a timestamp on SyncMessage.Sent, a
// valid destination, a body of at most 2048 bytes, styles with a start and a length), and Signal-Desktop's
// sendSyncMessage, which sends the transcript with the message's own timestamp.

import { fromBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { AttachmentPointer_Flags, BodyRange_Style, ContentSchema } from '../src/gen/SignalService_pb';
import { bodyFits, MAX_BODY_BYTES, type Note, noteToSelfMessage, trimBody } from '../src/signal/note-to-self';
import './wasm';

/** An account ID in the form with hyphens; the repository holds none written out. */
const ACI = `${'0'.repeat(8)}-0000-4000-8000-${'a'.padStart(12, '0')}`;
/** 9 March 2021, 14:05:07.123 UTC: years before the test runs. */
const OLD = Date.UTC(2021, 2, 9, 14, 5, 7, 123);

function sentOf(note: Note) {
  const content = fromBinary(ContentSchema, noteToSelfMessage(ACI, note));
  if (content.content.case !== 'syncMessage') throw new Error('not a sync message');
  const sync = content.content.value;
  if (sync.content.case !== 'sent') throw new Error('not a sent transcript');
  return { sent: sync.content.value, padding: sync.padding };
}

describe('a note to self', () => {
  // Detects: a transcript the phone refuses or files under another conversation (no destination, or not the own
  // account), and a date other than the one asked for: the message's and the transcript's timestamps must both be
  // the note's, because the apps show one and identify the message by the other.
  it('is a sent transcript to the own account that carries the note’s date twice', () => {
    const { sent, padding } = sentOf({ timestamp: OLD, body: 'Buy oat milk', styles: [] });
    expect(sent.destinationServiceId).toBe(ACI);
    expect(sent.timestamp).toBe(BigInt(OLD));
    expect(sent.message?.timestamp).toBe(BigInt(OLD));
    expect(sent.message?.body).toBe('Buy oat milk');
    expect(padding.length).toBeGreaterThan(0);
  });

  // Detects: a timer on the message. With an old date, Signal's apps would delete the message as soon as it
  // arrives.
  it('carries no timer for disappearing messages', () => {
    const { sent } = sentOf({ timestamp: OLD, body: 'x', styles: [] });
    expect(sent.message?.expireTimer).toBe(0);
    expect(sent.expirationStartTimestamp).toBe(0n);
  });

  // Detects: styles lost or put on the wrong characters.
  it('carries each style with its start and length', () => {
    const { sent } = sentOf({
      timestamp: OLD,
      body: 'bold and code',
      styles: [
        { start: 0, length: 4, style: 'bold' },
        { start: 9, length: 4, style: 'monospace' },
      ],
    });
    expect(sent.message?.bodyRanges.map((range) => [range.start, range.length, range.associatedValue])).toEqual([
      [0, 4, { case: 'style', value: BodyRange_Style.BOLD }],
      [9, 4, { case: 'style', value: BodyRange_Style.MONOSPACE }],
    ]);
  });

  // Detects: a body beyond what Signal's apps accept being sent; they drop the whole message.
  it('refuses a body longer than Signal’s apps accept, counted in bytes', () => {
    expect(bodyFits('a'.repeat(MAX_BODY_BYTES))).toBe(true);
    expect(bodyFits('a'.repeat(MAX_BODY_BYTES + 1))).toBe(false);
    // "é" is two bytes in UTF-8: 1025 of them are 2050 bytes.
    expect(bodyFits('é'.repeat(1025))).toBe(false);
    expect(() => noteToSelfMessage(ACI, { timestamp: OLD, body: 'é'.repeat(1025), styles: [] })).toThrow(/2048/);
  });

  // Detects: attachment pointers missing required fields (cdnKey, cdnNumber, key, digest, size, contentType,
  // clientUuid, uploadTimestamp, flags) or an attachment-only note carrying an empty body string.
  it('encodes AttachmentPointers with flags and metadata, and omits an empty body', () => {
    const key = new Uint8Array(64).fill(3);
    const digest = new Uint8Array(32).fill(9);
    const { sent } = sentOf({
      timestamp: OLD,
      body: '',
      styles: [],
      attachments: [
        {
          cdnNumber: 3,
          cdnKey: 'abc123',
          key,
          digest,
          size: 12_345,
          uploadTimestamp: 1_700_000_000_000,
          contentType: 'image/jpeg',
          width: 1280,
          height: 960,
          flags: AttachmentPointer_Flags.BORDERLESS,
        },
      ],
    });
    expect(sent.message?.body).toBe('');
    expect(sent.message?.attachments).toHaveLength(1);
    const pointer = sent.message!.attachments[0];
    expect(pointer.attachmentIdentifier).toEqual({ case: 'cdnKey', value: 'abc123' });
    expect(pointer.cdnNumber).toBe(3);
    expect(pointer.contentType).toBe('image/jpeg');
    expect(pointer.size).toBe(12_345);
    expect(pointer.width).toBe(1280);
    expect(pointer.height).toBe(960);
    expect(pointer.flags).toBe(AttachmentPointer_Flags.BORDERLESS);
    expect(pointer.clientUuid).toHaveLength(16);
    expect(pointer.key).toEqual(key);
    expect(pointer.digest).toEqual(digest);
    expect(pointer.uploadTimestamp).toBe(1_700_000_000_000n);
  });

  // Detects: trimBody splitting a multi-byte character or emoji surrogate pair when truncating a long message.
  it('trims long bodies to <= 2048 UTF-8 bytes without splitting emojis or surrogate pairs', () => {
    const emojis = '🦊'.repeat(600); // 4 UTF-8 bytes each -> 2400 bytes -> max 512 emojis = 2048 bytes
    const trimmed = trimBody(emojis);
    expect(bodyFits(trimmed)).toBe(true);
    expect(trimmed).toBe('🦊'.repeat(512));
  });
});
