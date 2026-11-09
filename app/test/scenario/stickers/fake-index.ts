// A simulated sticker pack index with the server's rules (crates/server/src/index.rs): append-only entries, reads
// from an offset in pages, a duplicate entry stored once, claims for 15 minutes that their holder can renew, and
// an add that ends the pack's claim.

import type { AddResult, ClaimResult, IndexBackend } from '../../../src/kinds/stickers/pack-index';
import { hex } from '../bytes';
import type { Clock } from '../../../src/core/clock';

export const CLAIM_MS = 15 * 60_000;

export class FakeIndex {
  entries: Uint8Array[] = [];
  #claims = new Map<string, { claimant: string; expires: number }>();
  /** The next this-many claims, and adds, answer "busy", as the server's per-address limit does. */
  busy = { claims: 0, adds: 0 };
  adds = 0;
  claims = 0;

  constructor(
    readonly clock: Pick<Clock, 'now'>,
    readonly pageSize = 3,
  ) {}

  readonly backend: IndexBackend = {
    read: async (from: number) => {
      const page = this.entries.slice(from, from + this.pageSize);
      return new Uint8Array(page.flatMap((entry) => [...entry]));
    },
    claim: async (lookupKey: Uint8Array, claimant: Uint8Array): Promise<ClaimResult> => {
      this.claims++;
      if (lookupKey.length !== 32 || claimant.length !== 32) throw new Error('malformed claim');
      const key = hex(lookupKey);
      const held = this.#claims.get(key);
      if (held && held.expires > this.clock.now() && held.claimant !== hex(claimant)) return 'held-by-someone-else';
      if (this.busy.claims > 0) {
        this.busy.claims--;
        return 'busy';
      }
      this.#claims.set(key, { claimant: hex(claimant), expires: this.clock.now() + CLAIM_MS });
      return 'granted';
    },
    add: async (entry: Uint8Array): Promise<AddResult> => {
      if (entry.length !== 48) throw new Error('malformed entry');
      if (this.entries.some((existing) => hex(existing) === hex(entry))) return 'added';
      if (this.busy.adds > 0) {
        this.busy.adds--;
        return 'busy';
      }
      this.adds++;
      this.entries.push(entry.slice());
      this.#claims.delete(hex(entry.subarray(0, 32)));
      return 'added';
    },
  };

  /** Someone else claims a pack (for example a user who then closes the page). */
  claimAsSomeoneElse(lookupKey: Uint8Array): void {
    this.#claims.set(hex(lookupKey), { claimant: 'someone else', expires: this.clock.now() + CLAIM_MS });
  }
}
