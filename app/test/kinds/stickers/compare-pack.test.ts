// The comparison of a sticker pack on Signal with the Telegram pack it is said to copy.

import '../../wasm';
import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import UPNG from 'upng-js';
import { StickerPack_StickerSchema, StickerPackSchema } from '../../../src/gen/Stickers_pb';
import {
  type OriginalPack,
  type PackFiles,
  type PictureComparison,
  isFaithfulCopy,
} from '../../../src/kinds/stickers/compare-pack';
import { MAX_STICKER_BYTES, manifestFor } from '../../../src/kinds/stickers/upload';
import { encryptStickerFile } from '../../../src/wasm/signal_migration_wasm';

const PACK_ID = new Uint8Array(16).fill(5);
const PACK_KEY = new Uint8Array(32).fill(0x42);

const still = (byte: number) => new Uint8Array([82, 73, 70, 70, byte, byte, byte]);
/** A Telegram pack of three still stickers, each small enough for Signal as it is. */
const cats: OriginalPack = {
  title: 'Cats',
  stickers: [
    { file: still(1), emoji: '🐈', format: 'webp' },
    { file: still(2), emoji: '😺', format: 'webp' },
    { file: still(3), emoji: '🙀', format: 'webp' },
  ],
};

/** What Signal's CDN holds for one pack: the plain files, which the CDN serves encrypted under `key`. */
class Copy implements PackFiles {
  manifestFile: Uint8Array | null;
  stickers: (Uint8Array | null)[];
  key = PACK_KEY;
  stickerReads = 0;

  /** The copy this app uploads for `pack` when no sticker needs converting. */
  constructor(pack: OriginalPack) {
    this.manifestFile = manifestFor({
      title: pack.title,
      stickers: pack.stickers.map((sticker) => ({ image: sticker.file, emoji: sticker.emoji })),
    });
    this.stickers = pack.stickers.map((sticker) => sticker.file);
  }

  async manifest(): Promise<Uint8Array | null> {
    return this.manifestFile && encryptStickerFile(this.manifestFile, this.key);
  }

  async sticker(_packId: Uint8Array, number: number): Promise<Uint8Array | null> {
    this.stickerReads++;
    const file = this.stickers[number] ?? null;
    return file && encryptStickerFile(file, this.key);
  }
}

/** A manifest with these fields, written as Signal's apps read it. */
function manifest(fields: {
  title?: string;
  author?: string;
  emoji: string[];
  ids?: number[];
  cover?: number;
  /** The number of a cover that carries the first sticker's emoji. */
  coverNumber?: number;
}): Uint8Array {
  const stickers = fields.emoji.map((emoji, i) =>
    create(StickerPack_StickerSchema, { id: fields.ids?.[i] ?? i, emoji }),
  );
  return toBinary(
    StickerPackSchema,
    create(StickerPackSchema, {
      title: fields.title ?? 'Cats',
      author: fields.author,
      cover:
        fields.coverNumber === undefined
          ? stickers[fields.cover ?? 0]
          : create(StickerPack_StickerSchema, { id: fields.coverNumber, emoji: fields.emoji[0] }),
      stickers,
    }),
  );
}

/** A comparison of pictures that must not be asked. */
const noPictures: PictureComparison = {
  sameStill: async () => {
    throw new Error('no still picture needs comparing here');
  },
  sameAnimation: async () => {
    throw new Error('no animation needs comparing here');
  },
};

const faithful = (copy: PackFiles, pack = cats, pictures = noPictures) =>
  isFaithfulCopy(PACK_ID, PACK_KEY, pack, copy, pictures);

const emoji = cats.stickers.map((sticker) => sticker.emoji);

describe('the comparison of a copy on Signal with the Telegram pack', () => {
  // Detects: the app's own uploads refused, so that every pack is uploaded again by everyone.
  it('accepts what this app uploads for the pack', async () => {
    expect(await faithful(new Copy(cats))).toBe(true);
  });

  // Detects: a copy accepted although its manifest says something else than the app would write: another title,
  // an author text, other emoji, the stickers in another order or number, or another cover.
  it('refuses a manifest that differs from the one this app writes', async () => {
    const differing: [string, Uint8Array][] = [
      ['another title', manifest({ title: 'Dogs', emoji })],
      ['an author', manifest({ author: 'someone', emoji })],
      ['another emoji', manifest({ emoji: ['🐈', '🐕', '🙀'] })],
      ['one sticker more', manifest({ emoji: [...emoji, '🐈'] })],
      ['one sticker fewer', manifest({ emoji: emoji.slice(0, 2) })],
      ['stickers numbered otherwise', manifest({ emoji, ids: [0, 2, 1] })],
      ['numbers that do not start at 0', manifest({ emoji, ids: [1, 2, 3] })],
      ['the second sticker as cover', manifest({ emoji, cover: 1 })],
      // A file beyond the stickers, which could hold any picture.
      ['a cover that is none of the stickers', manifest({ emoji, coverNumber: 3 })],
      ['a cover that is another sticker with the same emoji', manifest({ emoji: ['🐈', '🐈', '🙀'], coverNumber: 1 })],
      // Field 15 with the value 1: something this app never writes.
      ['a field of another kind', new Uint8Array([...manifest({ emoji }), 0x78, 0x01])],
      ['no manifest at all', new Uint8Array([1, 2, 3])],
    ];
    expect(await faithful(Object.assign(new Copy(cats), { manifestFile: manifest({ emoji }) })), 'the same').toBe(true);
    for (const [what, manifestFile] of differing) {
      expect(await faithful(Object.assign(new Copy(cats), { manifestFile })), what).toBe(false);
    }
  });

  // Detects: a copy accepted although a file is missing, or was encrypted by someone without the pack's key.
  it('refuses a copy with a missing file or a file under another key', async () => {
    const noManifest = Object.assign(new Copy(cats), { manifestFile: null });
    expect(await faithful(noManifest), 'no manifest').toBe(false);
    const noSticker = new Copy(cats);
    noSticker.stickers[2] = null;
    expect(await faithful(noSticker), 'a sticker missing').toBe(false);
    expect(await faithful(Object.assign(new Copy(cats), { key: new Uint8Array(32).fill(0x43) })), 'another key').toBe(
      false,
    );
  });

  // Detects: a still sticker that was changed accepted because it looks alike. A file that Signal takes as it is
  // must be the Telegram file byte for byte, and no picture is compared for it.
  it('wants a still sticker that needs no conversion to be the Telegram file itself', async () => {
    const copy = new Copy(cats);
    copy.stickers[1] = new Uint8Array([...still(2).subarray(0, 6), 9]);
    expect(await faithful(copy)).toBe(false);
    const longer = new Copy(cats);
    longer.stickers[1] = new Uint8Array([...still(2), 0]);
    expect(await faithful(longer)).toBe(false);
  });

  // Detects: a still sticker too large for Signal, which the app re-encodes, compared byte for byte (and so always
  // refused), accepted without its picture being compared, or accepted although its file holds more than one
  // still picture (which a Signal app may show differently than this page).
  it('wants a still sticker that had to be re-encoded to be a plain WebP file that shows the same', async () => {
    const large = { file: new Uint8Array(MAX_STICKER_BYTES + 1).fill(7), emoji: '🐈', format: 'webp' as const };
    const pack = { title: 'Cats', stickers: [large] };
    const copy = new Copy(pack);
    // A WebP file with one lossy picture of four bytes: 'RIFF', the length that follows, 'WEBP', and one chunk.
    const reencoded = new Uint8Array([
      82, 73, 70, 70, 16, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 4, 0, 0, 0, 9, 9, 9, 9,
    ]);
    copy.stickers[0] = reencoded;
    const asked: Uint8Array[][] = [];
    const says = (same: boolean): PictureComparison => ({
      ...noPictures,
      sameStill: async (converted, original) => {
        asked.push([converted, original]);
        return same;
      },
    });
    expect(await faithful(copy, pack, says(true))).toBe(true);
    expect(await faithful(copy, pack, says(false))).toBe(false);
    expect(asked[0]).toEqual([reencoded, large.file]);
    copy.stickers[0] = new Uint8Array([...reencoded, 0]);
    expect(await faithful(copy, pack, noPictures), 'bytes after the picture').toBe(false);
  });

  // Detects: an animated sticker accepted without its frames being compared, or although its file holds more than
  // a picture (which a Signal app may show differently than this page).
  it('wants an animated sticker to be a plain PNG file that shows the same', async () => {
    const pack: OriginalPack = { title: 'Cats', stickers: [{ file: still(1), emoji: '🐈', format: 'tgs' }] };
    const frames = [new Uint8Array(256).fill(40).buffer, new Uint8Array(256).fill(200).buffer];
    const png = new Uint8Array(UPNG.encode(frames, 8, 8, 256, [33, 33]));
    const says = (same: boolean): PictureComparison => ({ ...noPictures, sameAnimation: async () => same });
    const copy = new Copy(pack);
    copy.stickers[0] = png;
    expect(await faithful(copy, pack, says(true))).toBe(true);
    expect(await faithful(copy, pack, says(false))).toBe(false);
    copy.stickers[0] = new Uint8Array([...png, 0]);
    expect(await faithful(copy, pack, noPictures), 'bytes after the picture').toBe(false);
    copy.stickers[0] = still(1);
    expect(await faithful(copy, pack, noPictures), 'the Telegram file itself, which Signal cannot show').toBe(false);
  });

  // Detects: a failed request taken for a difference. The copy may be fine, and the page must not count it as bad.
  it('gives no answer when a file cannot be fetched', async () => {
    const copy = new Copy(cats);
    copy.sticker = async () => {
      throw new Error('the connection dropped');
    };
    await expect(faithful(copy)).rejects.toThrow('the connection dropped');
  });

  // Detects: a bad copy costing a full download. The comparison stops soon after the first difference.
  it('stops fetching after it found a difference', async () => {
    const many: OriginalPack = {
      title: 'Cats',
      stickers: Array.from({ length: 120 }, (_, i) => ({ file: still(i), emoji: '🐈', format: 'webp' as const })),
    };
    const copy = new Copy(many);
    copy.stickers[0] = still(200);
    expect(await faithful(copy, many)).toBe(false);
    expect(copy.stickerReads).toBeLessThan(20);
  });

  // Detects: an empty pack, which Signal does not take, accepted as a copy of an empty pack.
  it('refuses a pack without stickers', async () => {
    const empty = { title: 'Cats', stickers: [] };
    expect(await faithful(Object.assign(new Copy(cats), { manifestFile: manifest({ emoji: [] }) }), empty)).toBe(false);
  });
});
