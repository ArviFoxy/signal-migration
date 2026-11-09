// A simulated sticker pack index with the server's rules (crates/server/src/index.rs): append-only entries, reads
// from an offset in pages, and a duplicate entry stored once.

import type { AddResult, IndexBackend } from '../../../src/kinds/stickers/pack-index';
import { hex } from '../bytes';
import type { Clock } from '../../../src/core/clock';

export class FakeIndex {
  entries: Uint8Array[] = [];
  /** The next this-many adds answer "busy", as the server's per-address limit does. */
  busy = { adds: 0 };
  adds = 0;
  /** Runs before each read is answered: something that happens on the server meanwhile. */
  beforeRead: () => Promise<void> = async () => undefined;

  constructor(
    readonly clock: Pick<Clock, 'now'>,
    readonly pageSize = 3,
  ) {}

  readonly backend: IndexBackend = {
    read: async (from: number) => {
      await this.beforeRead();
      const page = this.entries.slice(from, from + this.pageSize);
      return new Uint8Array(page.flatMap((entry) => [...entry]));
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
      return 'added';
    },
  };
}
