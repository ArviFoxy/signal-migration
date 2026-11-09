import { createHash, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  contentPackKey,
  encodePackSource,
  type PackContent,
  type PackSource,
  packIdentity,
} from '../../../src/kinds/stickers/identity';

/** The encoding written out independently with Buffer: domain label, then length-prefixed fields. */
function referenceEncoding(source: PackSource): Buffer {
  const field = (text: string) => {
    const bytes = Buffer.from(text, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32BE(source.stickers.length);
  return Buffer.concat([
    Buffer.from('signal-migration sticker pack v1'),
    field(source.title),
    count,
    ...source.stickers.flatMap((s) => [field(s.uniqueId), field(s.emoji)]),
  ]);
}

const source: PackSource = {
  title: 'Cats 🐱',
  stickers: [
    { uniqueId: 'AgADBAADc', emoji: '😺' },
    { uniqueId: 'AgADBQADd', emoji: '😾' },
  ],
};

describe('packIdentity', () => {
  // Detects: a change to the encoding or the derivation labels, which would give every pack a new identity and make
  // all earlier uploads, including those under the first version's key, unfindable.
  it('derives the lookup key and the first version’s key with SHA-256 and HKDF-SHA256 under their labels', async () => {
    const sourceId = createHash('sha256').update(referenceEncoding(source)).digest();
    const derive = (label: string) => Buffer.from(hkdfSync('sha256', sourceId, Buffer.alloc(0), label, 32));
    const identity = await packIdentity(source);
    expect(Buffer.from(identity.sourceId)).toEqual(sourceId);
    expect(Buffer.from(identity.legacyPackKey)).toEqual(derive('signal-migration pack key v1'));
    expect(Buffer.from(identity.lookupKey)).toEqual(derive('signal-migration sticker-pack lookup v1'));
  });

  // Detects: an encoding without length prefixes, under which different packs share an identity (and so a Signal pack).
  it('encodes packs that differ only in where field boundaries fall differently', () => {
    const a = encodePackSource({ title: 'ab', stickers: [{ uniqueId: 'c', emoji: 'd' }] });
    const b = encodePackSource({ title: 'a', stickers: [{ uniqueId: 'bc', emoji: 'd' }] });
    const c = encodePackSource({ title: 'ab', stickers: [{ uniqueId: 'cd', emoji: '' }] });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });

  // Detects: the identity ignoring sticker order, which the Signal pack reproduces.
  it('gives a reordered pack a different identity', async () => {
    const reordered = { title: source.title, stickers: [...source.stickers].reverse() };
    expect(Buffer.from((await packIdentity(reordered)).lookupKey)).not.toEqual(
      Buffer.from((await packIdentity(source)).lookupKey),
    );
  });
});

/** The content encoding written out independently with Buffer: domain label, then length-prefixed fields. */
function referenceContentEncoding(content: PackContent): Buffer {
  const field = (bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const count = Buffer.alloc(4);
  count.writeUInt32BE(content.stickers.length);
  return Buffer.concat([
    Buffer.from('signal-migration sticker pack content v2'),
    field(Buffer.from(content.title, 'utf8')),
    count,
    ...content.stickers.flatMap((s) => [field(Buffer.from(s.file)), field(Buffer.from(s.emoji, 'utf8'))]),
  ]);
}

const content: PackContent = {
  title: 'Cats 🐱',
  stickers: [
    { file: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3]), emoji: '😺' },
    { file: new Uint8Array([0x1f, 0x8b, 9, 8, 7]), emoji: '😾' },
  ],
};

describe('contentPackKey', () => {
  // Detects: a change to the content encoding or its label, which would make every pack uploaded with it
  // unfindable.
  it('derives the pack key from the content with SHA-256 and HKDF-SHA256 under its label', async () => {
    const contentId = createHash('sha256').update(referenceContentEncoding(content)).digest();
    const expected = Buffer.from(hkdfSync('sha256', contentId, Buffer.alloc(0), 'signal-migration pack key v2', 32));
    expect(Buffer.from(await contentPackKey(content))).toEqual(expected);
  });

  // Detects: a pack key computed from something other than every sticker's file, such as the title or Telegram's
  // file identifiers, which anyone who knows the pack's name could compute without having its stickers.
  it('changes when any byte of any sticker changes', async () => {
    const key = Buffer.from(await contentPackKey(content));
    for (const [sticker, byte] of [
      [0, 0],
      [0, 6],
      [1, 4],
    ]) {
      const changed = structuredClone(content);
      changed.stickers[sticker].file[byte] ^= 1;
      expect(Buffer.from(await contentPackKey(changed))).not.toEqual(key);
    }
  });
});
