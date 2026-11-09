import { describe, expect, it } from 'vitest';
import { assignPositions, insertPacks } from '../../../src/kinds/stickers/order';

/** A seeded generator (mulberry32), so every failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pack = { name: string; rank: number | null };

function inversions(order: Pack[]): number {
  let count = 0;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i].rank;
      const b = order[j].rank;
      if (a !== null && b !== null && a > b) count++;
    }
  }
  return count;
}

/** Every way to insert `added` into `existing` keeping the existing order: an independent search for the minimum. */
function fewestInversionsByBruteForce(existing: Pack[], added: Pack[]): number {
  let best = Infinity;
  const place = (order: Pack[], remaining: Pack[]) => {
    if (remaining.length === 0) {
      best = Math.min(best, inversions(order));
      return;
    }
    const [next, ...rest] = remaining;
    for (let gap = 0; gap <= order.length; gap++) place([...order.slice(0, gap), next, ...order.slice(gap)], rest);
  };
  place(existing, added);
  return best;
}

/** A Telegram order of `rankedCount` packs, some already in Signal (in some order, among unranked packs), the rest new. */
function instance(next: () => number, rankedCount: number, unrankedCount: number) {
  const ranks = Array.from({ length: rankedCount }, (_, i) => i);
  const existingRanked = ranks.filter(() => next() < 0.5);
  const added = ranks.filter((rank) => !existingRanked.includes(rank)).map((rank) => ({ name: `new${rank}`, rank }));
  const existing: Pack[] = [
    ...existingRanked.map((rank) => ({ name: `old${rank}`, rank })),
    ...Array.from({ length: unrankedCount }, (_, i) => ({ name: `other${i}`, rank: null })),
  ];
  for (let i = existing.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [existing[i], existing[j]] = [existing[j], existing[i]];
  }
  return { existing, added };
}

const asExisting = (packs: Pack[]) => packs.map((pack) => ({ item: pack, rank: pack.rank }));
const asNew = (packs: Pack[]) => packs.map((pack) => ({ item: pack, rank: pack.rank as number }));

describe('insertPacks', () => {
  // Detects: a placement rule that leaves avoidable inversions, such as appending new packs at the end or
  // placing each pack next to its Telegram neighbour.
  it('reaches the fewest inversions possible without moving existing packs', () => {
    const next = random(1);
    for (let trial = 0; trial < 300; trial++) {
      const { existing, added } = instance(next, 1 + Math.floor(next() * 6), Math.floor(next() * 3));
      const order = insertPacks(asExisting(existing), asNew(added));
      expect(inversions(order), JSON.stringify({ existing, added })).toBe(
        fewestInversionsByBruteForce(existing, added),
      );
    }
  });

  // Detects: existing packs being reordered or dropped, or new packs lost or duplicated.
  it('keeps every pack, and the existing packs in their order', () => {
    const next = random(2);
    for (let trial = 0; trial < 200; trial++) {
      const { existing, added } = instance(next, 1 + Math.floor(next() * 10), Math.floor(next() * 4));
      const order = insertPacks(asExisting(existing), asNew(added));
      expect(order.filter((pack) => existing.includes(pack))).toEqual(existing);
      expect(new Set(order)).toEqual(new Set([...existing, ...added]));
    }
  });

  // Detects: a migration spread over several visits (rate limits, closed tab) ending in a different order than
  // migrating everything at once.
  it('ends in the same order whether new packs are inserted at once or over several visits', () => {
    const next = random(3);
    for (let trial = 0; trial < 300; trial++) {
      const { existing, added } = instance(next, 1 + Math.floor(next() * 10), Math.floor(next() * 4));
      const atOnce = insertPacks(asExisting(existing), asNew(added));
      let current = existing;
      let remaining = added;
      while (remaining.length > 0) {
        const batch = remaining.filter(() => next() < 0.4);
        const now = batch.length > 0 ? batch : [remaining[0]];
        current = insertPacks(asExisting(current), asNew(now));
        remaining = remaining.filter((pack) => !now.includes(pack));
      }
      expect(current.map((pack) => pack.name)).toEqual(atOnce.map((pack) => pack.name));
    }
  });
});

describe('insertPacks placement among unrelated packs', () => {
  // Detects: migrated packs being placed before the packs the user already had from elsewhere, when either
  // place forms the same inversions (the chosen rule puts them after).
  it('puts a new pack after packs not from Telegram when that forms no more inversions', () => {
    const other: Pack = { name: 'other', rank: null };
    const added: Pack = { name: 'new0', rank: 0 };
    expect(insertPacks([{ item: other, rank: null }], [{ item: added, rank: 0 }])).toEqual([other, added]);
  });
});

describe('assignPositions', () => {
  /** Signal's display order: by position, then by pack ID (here the pack's index stands in for a random ID). */
  const signalOrder = (positions: number[], packIds: number[]) =>
    positions
      .map((position, i) => ({ position, packId: packIds[i], i }))
      .sort((a, b) => a.position - b.position || a.packId - b.packId)
      .map((pack) => pack.i);

  // Detects: positions under which Signal would show the packs in another order than the intended one, whatever
  // pack IDs the new packs get.
  it('gives positions under which Signal shows the intended order', () => {
    const next = random(4);
    for (let trial = 0; trial < 500; trial++) {
      const length = 1 + Math.floor(next() * 8);
      // Existing positions as Signal clients leave them: non-decreasing, often with gaps or ties.
      let position = Math.floor(next() * 3);
      const order: (number | null)[] = [];
      const existingIds: number[] = [];
      for (let i = 0; i < length; i++) {
        if (next() < 0.5) order.push(null);
        else {
          position += Math.floor(next() * 3);
          order.push(position);
          existingIds.push(i);
        }
      }
      // Pack IDs: existing packs with equal positions are already sorted by ID; new packs get random IDs.
      const packIds = order.map((value, i) => (value === null ? Math.floor(next() * 1000) : i * 1000));
      const positions = assignPositions(order);
      expect(signalOrder(positions, packIds), JSON.stringify(order)).toEqual(order.map((_, i) => i));
    }
  });

  // Detects: rewriting every existing pack's record when the new packs fit between the existing positions.
  it('keeps existing positions when the new packs fit between them', () => {
    expect(assignPositions([0, 1, null, null])).toEqual([0, 1, 2, 3]);
    expect(assignPositions([null, 5, null, 9])).toEqual([0, 5, 6, 9]);
    expect(assignPositions([3, 3, null])).toEqual([3, 3, 4]);
  });
});
