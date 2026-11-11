// The tool that saves a sample of a user's animated Telegram stickers for measuring the picture comparison
// (measure/save-packs.ts), run on the workflow against the scenario world.

import { describe, expect, it } from 'vitest';
import { savePacksOnceRead, withTelegramSource } from '../../measure/save-packs';
import { isSession } from '../../src/app/machine/app';
import { Workflow } from '../../src/app/workflow';
import { appServices, Browser } from '../scenario/stickers/app-services';
import { type PackSpec, StickerWorld } from '../scenario/stickers/sticker-world';

/** Waits until `condition` holds, letting the page's background work run. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`${what}: never happened`);
}

/**
 * Opens the app for a user with these packs, logs in to Telegram and lets the tool save; `kept` are the packs the
 * keeper has already. Gives what the keeper was sent, by path, and what it showed.
 */
async function saveFor(world: StickerWorld, packs: PackSpec[], kept: string[] = []) {
  const user = world.user(packs);
  const page = appServices(user, new Browser());
  const { services, source } = withTelegramSource(page.services);
  const workflow = new Workflow(services);
  const sent = new Map<string, Uint8Array | string>();
  const shown: string[] = [];
  const saved = savePacksOnceRead(workflow, source, {
    saved: async () => kept,
    send: async (path, body) => void sent.set(path, body),
    show: (text) => void shown.push(text),
  });
  workflow.start();
  await until(() => isSession(workflow.state), 'the page loaded');
  expect(sent.size, 'nothing is saved before the login').toBe(0);
  workflow.goTo('packs');
  await until(() => page.scanTelegramCode(), 'a Telegram QR code to scan');
  await saved;
  return { user, sent, shown, setIds: workflow.stickers!.entries.map((entry) => entry.pack.setId) };
}

const packPaths = (sent: Map<string, unknown>) => [...sent.keys()].filter((path) => path.startsWith('pack/'));

describe('saving a sample of the animated stickers', () => {
  // Detects: the tool doing nothing after the Telegram login, saving a file under another pack or number, saving
  // something else than the file Telegram has, or saving still stickers, which need no measuring.
  it('saves the animations of a pack as Telegram has them, with the pack described, and no still pack', async () => {
    const world = new StickerWorld();
    const stills = world.pack('Stills', 3);
    const vector = world.pack('Vector', 2, { format: 'tgs' });
    const video = world.pack('Video', 2, { format: 'webm' });
    const { sent, shown, setIds } = await saveFor(world, [stills, vector, video]);
    for (const [number, spec] of [vector, video].entries()) {
      const setId = setIds[number + 1];
      expect(JSON.parse(sent.get(`pack/${setId}`) as string)).toEqual({
        title: spec.title,
        stickers: spec.stickers.map(({ emoji, format }) => ({ emoji, format })),
      });
      for (const [i, sticker] of spec.stickers.entries()) {
        expect(sent.get(`file/${setId}/${i}.${sticker.format}`), `${spec.title} #${i}`).toEqual(sticker.bytes);
      }
    }
    expect(sent.size).toBe(2 * (2 + 1));
    expect(shown.at(-1)).toBe('Stickers saved: 2 packs');
  });

  // Detects: the whole collection being saved where a sample is wanted: more than 20 packs of one kind, or more
  // than 30 stickers of one pack.
  it('saves no more than 20 packs of a kind and 30 stickers of a pack', async () => {
    const world = new StickerWorld();
    const packs = [
      world.pack('Long', 35, { format: 'tgs' }),
      ...Array.from({ length: 22 }, (_, i) => world.pack(`Vector ${i}`, 1, { format: 'tgs' })),
      world.pack('Video', 1, { format: 'webm' }),
    ];
    const { sent, setIds } = await saveFor(world, packs);
    expect(packPaths(sent)).toEqual([...setIds.slice(0, 20), setIds[23]].map((setId) => `pack/${setId}`));
    const ofLong = [...sent.keys()].filter((path) => path.startsWith(`file/${setIds[0]}/`));
    expect(ofLong).toEqual(Array.from({ length: 30 }, (_, i) => `file/${setIds[0]}/${i}.tgs`));
  });

  // Detects: a reload reading a pack from Telegram again although it is kept, or a kept pack not counting towards
  // the 20, so that a reload saves more packs than the sample.
  it('leaves out a pack that is kept already and counts it as one of the sample', async () => {
    const world = new StickerWorld();
    const packs = Array.from({ length: 21 }, (_, i) => world.pack(`Vector ${i}`, 1, { format: 'tgs' }));
    // The simulated Telegram numbers the packs from 1 in the user's order.
    const { user, sent, setIds } = await saveFor(world, packs, ['1']);
    expect(packPaths(sent)).toEqual(setIds.slice(1, 20).map((setId) => `pack/${setId}`));
    expect(user.stickers.stickerReads('Vector 0')).toBe(0);
  });
});
