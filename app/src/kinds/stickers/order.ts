// Where migrated packs go in the user's Signal sticker order.
//
// Packs already in Signal stay where the user put them. Each new pack is inserted into one of the gaps between
// them. A Signal pack migrated from Telegram has a rank, its place in the user's Telegram order; other Signal packs
// have none. An inversion is a pair of ranked packs whose Signal order disagrees with their ranks.
//
// For a new pack of rank r inserted at gap g (g packs before it), the inversions it forms with existing packs are
//   cost_r(g) = #{ranked packs before g with rank > r} + #{ranked packs at or after g with rank < r}.
// Moving from gap g to g + 1 passes existing pack g, which changes the cost by +1 if its rank is above r, by -1 if
// below r, and by 0 if it has none. That step is never larger for a higher r, so the difference
// cost_r'(g) - cost_r(g) for r' > r does not increase with g, and the largest minimizing gap does not decrease
// with r. Inserting each new pack at its largest minimizing gap therefore keeps the new packs in Telegram order,
// which forms no inversions among them, and each one's inversions with the existing packs are at their minimum.
// The total is the least possible without moving existing packs.
//
// Taking the largest minimizer places a new pack after unranked packs rather than before them.

export type ExistingPack<T> = { item: T; rank: number | null };
export type NewPack<T> = { item: T; rank: number };

/** The largest gap in `existing` (0 to existing.length) where a pack of rank `rank` forms the fewest inversions. */
export function bestGap(existingRanks: (number | null)[], rank: number): number {
  let cost = existingRanks.filter((other) => other !== null && other < rank).length;
  let best = 0;
  let bestCost = cost;
  existingRanks.forEach((other, index) => {
    if (other !== null) cost += other > rank ? 1 : other < rank ? -1 : 0;
    if (cost <= bestCost) {
      bestCost = cost;
      best = index + 1;
    }
  });
  return best;
}

/** The final order: the existing packs in their order, with each new pack inserted at its best gap. */
export function insertPacks<T>(existing: ExistingPack<T>[], added: NewPack<T>[]): T[] {
  const ranks = existing.map((pack) => pack.rank);
  const byGap = new Map<number, NewPack<T>[]>();
  for (const pack of added) {
    const gap = bestGap(ranks, pack.rank);
    byGap.set(gap, [...(byGap.get(gap) ?? []), pack]);
  }
  const order: T[] = [];
  for (let gap = 0; gap <= existing.length; gap++) {
    order.push(...(byGap.get(gap) ?? []).sort((a, b) => a.rank - b.rank).map((pack) => pack.item));
    if (gap < existing.length) order.push(existing[gap].item);
  }
  return order;
}

const MAX_POSITION = 0xffffffff;

/**
 * Signal positions for packs listed in their final order, where existing packs carry their current position and
 * new packs carry null. Signal sorts packs by position, then by pack ID. Existing positions are kept when every run
 * of new packs fits strictly between the positions around it; otherwise every pack is numbered from 0.
 */
export function assignPositions(order: (number | null)[]): number[] {
  const positions: number[] = [];
  let previous = -1;
  let index = 0;
  while (index < order.length) {
    const current = order[index];
    if (current !== null) {
      positions.push(current);
      previous = current;
      index++;
      continue;
    }
    let runEnd = index;
    while (runEnd < order.length && order[runEnd] === null) runEnd++;
    const next = runEnd < order.length ? (order[runEnd] as number) : MAX_POSITION + 1;
    const runLength = runEnd - index;
    if (next - previous - 1 < runLength) return order.map((_, i) => i);
    for (let offset = 1; offset <= runLength; offset++) positions.push(previous + offset);
    previous += runLength;
    index = runEnd;
  }
  return positions;
}
