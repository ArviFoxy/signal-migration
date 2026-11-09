import { createHash, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodePackSource, type PackSource, packIdentity } from '../../../src/kinds/stickers/identity';

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
  // all earlier uploads unfindable.
  it('derives the keys with SHA-256 and HKDF-SHA256 under the documented labels', async () => {
    const sourceId = createHash('sha256').update(referenceEncoding(source)).digest();
    const derive = (label: string) => Buffer.from(hkdfSync('sha256', sourceId, Buffer.alloc(0), label, 32));
    const identity = await packIdentity(source);
    expect(Buffer.from(identity.sourceId)).toEqual(sourceId);
    expect(Buffer.from(identity.packKey)).toEqual(derive('signal-migration pack key v1'));
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
