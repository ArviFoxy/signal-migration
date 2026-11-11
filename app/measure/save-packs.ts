// Saves animated sticker files of some of the Telegram packs the app has read, for choosing the tolerances of the
// picture comparison from real stickers (export-page.ts). The files go to whoever `Keeper` stands for; in the page,
// the server that served it.
//
// Only animations are saved: a still sticker within Signal's size limit is compared byte for byte, with no
// tolerance. A sample is enough, so it saves the first PACKS_PER_FORMAT packs of vector animations and as many of
// video stickers, and of each the first STICKERS_PER_PACK animations.

import type { AppServices } from '../src/app/services';
import type { Workflow } from '../src/app/workflow';
import type { TelegramSource } from '../src/kinds/stickers/telegram-packs';

/** How many sticker files are read from Telegram at the same time, as in the migration. */
const CONCURRENT_DOWNLOADS = 4;
export const PACKS_PER_FORMAT = 20;
export const STICKERS_PER_PACK = 30;

/** Where the files are kept. */
export type Keeper = {
  /** Telegram's IDs of the packs that are kept in full. */
  saved(): Promise<string[]>;
  /** Keeps a sticker file (`file/<pack ID>/<number>.<format>`) or, after its files, a pack's description (`pack/<pack ID>`). */
  send(path: string, body: Uint8Array | string): Promise<void>;
  /** Shows one line of progress. */
  show(text: string): void;
};

/** The app's services, and the file source of the Telegram session the app started last through them. */
export function withTelegramSource(services: AppServices): {
  services: AppServices;
  source: () => TelegramSource | null;
} {
  let source: TelegramSource | null = null;
  return {
    source: () => source,
    services: {
      ...services,
      telegram: {
        ...services.telegram,
        start(...args) {
          const session = services.telegram.start(...args);
          source = session.source;
          return session;
        },
      },
    },
  };
}

/**
 * Saves the sample: of each chosen pack, its animations as Telegram has them, under their numbers in the pack, then
 * the pack's description. A pack that is kept already counts as chosen and is not read again.
 */
async function savePacks(workflow: Workflow, files: TelegramSource, keeper: Keeper): Promise<void> {
  const kept = new Set(await keeper.saved());
  const chosen = { tgs: 0, webm: 0 };
  const failed: string[] = [];
  for (const pack of workflow.stickers!.entries.map((entry) => entry.pack)) {
    const animations = pack.stickers
      .map((sticker, number) => ({ ...sticker, number }))
      .filter((sticker) => sticker.format !== 'webp')
      .slice(0, STICKERS_PER_PACK);
    if (animations.length === 0) continue;
    const format = animations[0].format as 'tgs' | 'webm';
    if (chosen[format] >= PACKS_PER_FORMAT) continue;
    chosen[format]++;
    keeper.show(`Saving stickers: ${chosen.tgs + chosen.webm} of at most ${2 * PACKS_PER_FORMAT} packs`);
    if (kept.has(pack.setId)) continue;
    try {
      let next = 0;
      const readNext = async () => {
        while (next < animations.length) {
          const sticker = animations[next++];
          await keeper.send(
            `file/${pack.setId}/${sticker.number}.${sticker.format}`,
            await files.readFile(sticker.fileId),
          );
        }
      };
      await Promise.all(Array.from({ length: CONCURRENT_DOWNLOADS }, readNext));
      const stickers = pack.stickers.map(({ emoji, format }) => ({ emoji, format }));
      await keeper.send(`pack/${pack.setId}`, JSON.stringify({ title: pack.title, stickers }));
    } catch (error) {
      failed.push(`${pack.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const done = `Stickers saved: ${chosen.tgs + chosen.webm - failed.length} packs`;
  keeper.show(failed.length === 0 ? done : `${done}. Failed: ${failed.join('; ')}`);
}

/**
 * Saves the packs once the app has read them from Telegram, which it does after the Telegram login. Resolves when
 * every pack was saved or has failed.
 */
export function savePacksOnceRead(
  workflow: Workflow,
  source: () => TelegramSource | null,
  keeper: Keeper,
): Promise<void> {
  return new Promise((resolve) => {
    const onChange = () => {
      const files = source();
      if (!files || !workflow.packsReady || !workflow.stickers) return;
      workflow.removeEventListener('change', onChange);
      void savePacks(workflow, files, keeper).then(resolve);
    };
    workflow.addEventListener('change', onChange);
  });
}
