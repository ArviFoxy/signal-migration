// Scenarios of the sticker pack migration, run against simulated Signal, index and Telegram services
// (test/scenario/ and test/scenario/stickers/). Each test names the failure it exists to catch.

import { describe, expect, it } from 'vitest';
import { ManifestRecord_Identifier_Type } from '../../../src/gen/SignalStorage_pb';
import { packIdentity } from '../../../src/kinds/stickers/identity';
import { DownloadStalledError } from '../../../src/telegram/download';
import { packKeyOf, StickerWorld } from '../../scenario/stickers/sticker-world';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const UPLOAD_INTERVAL = 72 * MINUTE;

describe('a first migration', () => {
  // Detects: packs missing from Signal after a migration, or installed in another order than in Telegram.
  it('uploads every pack and installs them in Telegram order', async () => {
    const world = new StickerWorld();
    const alice = world.user([
      world.pack('Cats'),
      world.pack('Foxes', 2, { format: 'tgs' }),
      world.pack('Dragons', 4, { format: 'webm' }),
    ]);
    const page = await alice.visit();
    expect(page.migration.phase).toBe('done');
    expect(await alice.installedTitles()).toEqual(['Cats', 'Foxes', 'Dragons']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(3);
    expect(world.index.entries).toHaveLength(3);
  });

  // Detects: stickers swapped, lost or corrupted on the way, emoji not carried over, or an author leaking who
  // uploaded the pack.
  it('uploads each sticker with its emoji, under the Telegram title, with no author', async () => {
    const world = new StickerWorld();
    const spec = world.pack('Cats', 4);
    const alice = world.user([spec]);
    await alice.visit();
    const [installed] = await alice.installedPacks();
    const manifest = world.readManifest(installed.packId, installed.packKey);
    expect(manifest.title).toBe('Cats');
    expect(manifest.author).toBe('');
    expect(manifest.stickers.map((sticker) => sticker.emoji)).toEqual(spec.stickers.map((sticker) => sticker.emoji));
    expect(world.readStickers(installed.packId, installed.packKey)).toEqual(
      spec.stickers.map((sticker) => sticker.bytes),
    );
  });

  // Detects: the migration rewriting or dropping storage records it does not own (contacts and the rest).
  it('leaves every other storage record unchanged', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B')], { contacts: 5 });
    const before = world.signal.storageItems(alice.aci);
    await alice.visit();
    const after = world.signal.storageItems(alice.aci);
    for (const [key, value] of before) expect(after.get(key)).toEqual(value);
    const { manifest } = await (await alice.phone.storage()).readStickerPacks();
    expect(manifest.identifiers.filter((id) => id.type === ManifestRecord_Identifier_Type.CONTACT)).toHaveLength(5);
  });

  // Detects: storage keys derived only one way, failing on accounts whose manifest predates the record key material.
  it('works on an account whose storage manifest has no record key material', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')], { recordIkm: false, contacts: 1 });
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['A']);
  });
});

describe('downloads that stall', () => {
  // Detects: a stalled download stopping the migration, or its pack failing without saying which sticker and how
  // far the download got.
  it('fails only the pack whose download stalled, naming the sticker, and goes on', async () => {
    const world = new StickerWorld();
    const [a, b] = [world.pack('A'), world.pack('B')];
    const alice = world.user([a, b]);
    alice.stickers.failNextStickerRead('A', new DownloadStalledError(12 * 1024, 48 * 1024, 60_000));
    const page = await alice.visit();
    expect(page.entry('A').state).toBe('failed');
    expect(page.entry('A').error).toBe(
      'sticker 1: downloading from Telegram made no progress for 60 seconds (12 of 48 KB received)',
    );
    expect(await alice.installedTitles()).toEqual(['B']);
  });
});

describe('sharing uploads between users', () => {
  // Detects: a pack being uploaded again although someone already uploaded it. Its stickers are downloaded: the
  // pack key is computed from them.
  it('installs packs someone else uploaded without uploading them', async () => {
    const world = new StickerWorld();
    const [a, b, c] = [world.pack('A'), world.pack('B'), world.pack('C')];
    await world.user([a, b]).visit();
    const bob = world.user([b, c, a]);
    await bob.visit();
    expect(await bob.installedTitles()).toEqual(['B', 'C', 'A']);
    expect(world.signal.packsUploaded.get(bob.aci)).toBe(1);
  });

  // Detects: an upload under a key that can be computed without the pack's stickers (from its name or Telegram's
  // file identifiers), so that knowing which pack it is would be enough to decrypt it.
  it('uploads under the key computed from the stickers', async () => {
    const world = new StickerWorld();
    const a = world.pack('A');
    const alice = world.user([a]);
    await alice.visit();
    const [installed] = await alice.installedPacks();
    expect(Buffer.from(installed.packKey)).toEqual(Buffer.from(await packKeyOf(a)));
    expect(world.readStickers(installed.packId, installed.packKey)).toHaveLength(a.stickers.length);
  });

  // Detects: an index entry that anyone added, pointing a Telegram pack at another pack the user has installed, which
  // makes the migration skip the Telegram pack as if it were installed.
  it('does not take another installed pack for this one because of an index entry', async () => {
    const world = new StickerWorld();
    const a = world.pack('A');
    const other = await world.publishSignalPack('Other');
    await world.index.backend.add(new Uint8Array([...(await packIdentity(a)).lookupKey, ...other.packId]));
    const bob = world.user([a]);
    await bob.installOnPhone(other);
    await bob.visit();
    expect((await bob.installedTitles()).sort()).toEqual(['A', 'Other']);
    expect(world.signal.packsUploaded.get(bob.aci)).toBe(1);
  });

  // Detects: a pack the user already has installed, from an upload the index lists, downloaded or uploaded again:
  // its key is in the user's account, so the stickers are not needed.
  it('recognizes an installed pack from the index without downloading it', async () => {
    const world = new StickerWorld();
    const a = world.pack('A');
    const packId = await world.migrateElsewhere(a);
    const bob = world.user([a]);
    await bob.installOnPhone({ packId, packKey: await packKeyOf(a) });
    await bob.visit();
    expect(await bob.installedTitles()).toEqual(['A']);
    expect(world.signal.packsUploaded.get(bob.aci) ?? 0).toBe(0);
    expect(bob.stickers.stickerReads('A')).toBe(0);
  });

  // Detects: lookups that read only the first page of the index.
  it('finds a pack whose entry is beyond the first page of the index', async () => {
    const world = new StickerWorld({ indexPageSize: 3 });
    for (let i = 0; i < 7; i++) await world.migrateElsewhere(world.pack(`Other ${i}`));
    const a = world.pack('A');
    await world.migrateElsewhere(a);
    const alice = world.user([a]);
    await alice.visit();
    expect(world.signal.packsUploaded.get(alice.aci) ?? 0).toBe(0);
    expect(await alice.installedTitles()).toEqual(['A']);
  });

  // Detects: trusting an index entry without checking that the pack on Signal's CDN opens with the derived key, which
  // would let a wrong or forged entry install someone else's pack.
  it('ignores an index entry whose pack does not open with the derived key', async () => {
    const world = new StickerWorld();
    const a = world.pack('A');
    const decoy = await world.publishSignalPack('Decoy');
    await world.index.backend.add(new Uint8Array([...(await packIdentity(a)).lookupKey, ...decoy.packId]));
    const alice = world.user([a]);
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['A']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(1);
    const carol = world.user([a]);
    await carol.visit();
    expect(await carol.installedTitles()).toEqual(['A']);
    expect(world.signal.packsUploaded.get(carol.aci) ?? 0).toBe(0);
  });

  // Detects: a pack uploaded twice when someone else uploaded it while this page was converting it: the index must
  // be asked again right before the upload.
  it('installs the upload someone made while this page converted the pack, instead of uploading it', async () => {
    const world = new StickerWorld();
    const a = world.pack('A');
    const alice = world.user([a]);
    let converting = false;
    let uploadedElsewhere = false;
    world.index.beforeRead = async () => {
      if (!converting || uploadedElsewhere) return;
      uploadedElsewhere = true;
      await world.migrateElsewhere(a);
    };
    await alice.visit({
      onChange: (migration) => {
        if (migration.entries.some((entry) => entry.state === 'converting')) converting = true;
      },
    });
    expect(uploadedElsewhere).toBe(true);
    expect(await alice.installedTitles()).toEqual(['A']);
    expect(world.signal.packsUploaded.get(alice.aci) ?? 0).toBe(0);
  });

  // Detects: an upload whose index entry could not be added at first being uploaded a second time.
  it('retries adding to the index while the index server limits requests, without uploading again', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    world.index.busy.adds = 2;
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['A']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(1);
    expect(world.index.entries).toHaveLength(1);
  });
});

describe("the user's existing Signal packs", () => {
  // Detects: existing packs being moved, or new packs placed so that they disagree with the Telegram order more than
  // necessary.
  it('keeps existing packs in place and inserts new ones in Telegram order', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    await alice.installOnPhone(await world.publishSignalPack('X'));
    await alice.visit({ select: (title) => title === 'C' });
    await alice.installOnPhone(await world.publishSignalPack('Y'));
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['X', 'A', 'B', 'C', 'Y']);
  });

  // Detects: a second visit re-uploading, re-installing or rewriting packs that are already there.
  it('changes nothing on a visit after the migration finished', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B')]);
    await alice.visit();
    const writes = world.signal.storageWrites;
    const forms = world.signal.formsIssued.get(alice.aci);
    const again = await alice.visit();
    expect(again.migration.entries.map((entry) => entry.state)).toEqual(['in-signal', 'in-signal']);
    expect(world.signal.storageWrites).toBe(writes);
    expect(world.signal.formsIssued.get(alice.aci)).toBe(forms);
  });

  // Detects: a reinstalled pack leaving its removal record beside the new one, which Signal clients could read as
  // removed.
  it('replaces the removal record of a pack the user uninstalled earlier', async () => {
    const world = new StickerWorld();
    const a = world.pack('A');
    const packId = await world.migrateElsewhere(a);
    const alice = world.user([a]);
    await alice.installOnPhone({ packId, packKey: await packKeyOf(a) });
    await alice.uninstallOnPhone(packId);
    await alice.visit();
    const snapshot = await (await alice.phone.storage()).readStickerPacks();
    expect(snapshot.removed).toHaveLength(0);
    expect(snapshot.packs).toHaveLength(1);
    expect(await alice.installedTitles()).toEqual(['A']);
  });

  // Detects: a write that conflicts with another device's change failing the migration or overwriting that change.
  it('writes again when another device changed the storage meanwhile, keeping both changes', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B')], { contacts: 2 });
    const x = await world.publishSignalPack('X');
    world.signal.beforeNextStorageWrite(() => alice.installOnPhone(x));
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['X', 'A', 'B']);
  });
});

describe("Signal's upload limit", () => {
  // Detects: uploads beyond the allowance failing instead of waiting for Signal's limit.
  it('waits for the limit and finishes', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 2, intervalMs: UPLOAD_INTERVAL } });
    const alice = world.user(['A', 'B', 'C', 'D'].map((title) => world.pack(title)));
    let waited = false;
    const start = world.clock.now();
    const page = await alice.visit({ onChange: (migration) => (waited ||= migration.uploadAllowedAt !== null) });
    expect(page.migration.phase).toBe('done');
    expect(waited).toBe(true);
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C', 'D']);
    expect(world.clock.now() - start).toBeGreaterThanOrEqual(2 * UPLOAD_INTERVAL - MINUTE);
  });

  // Detects: a migration spread over several visits ending in another order, or uploading a pack twice.
  it('ends in the same state when the user leaves during a wait and comes back later', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 2, intervalMs: UPLOAD_INTERVAL } });
    const alice = world.user(['A', 'B', 'C', 'D', 'E'].map((title) => world.pack(title)));
    const first = await alice.visit({ leaveAfterWaitOf: 10 * MINUTE });
    expect(first.left).toBe(true);
    expect(await alice.installedTitles()).toEqual(['A', 'B']);
    await world.clock.advance(5 * HOUR);
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(5);
  });
});

describe('failures', () => {
  // Detects: one unconvertible sticker stopping the whole migration, or a partly converted pack being uploaded.
  it('fails only the pack with a sticker that cannot be converted', async () => {
    const world = new StickerWorld();
    const alice = world.user([
      world.pack('A'),
      world.pack('B', 3, { format: 'tgs', unconvertible: [1] }),
      world.pack('C'),
    ]);
    const page = await alice.visit();
    expect(await alice.installedTitles()).toEqual(['A', 'C']);
    expect(page.entry('B').state).toBe('failed');
    expect(page.entry('B').error).toMatch(/does not fit/);
    expect(world.index.entries).toHaveLength(2);
  });

  // Detects: a failed Telegram download stopping the migration, or not being downloaded again on retry.
  it('fails only the pack whose download failed, and downloads it again on retry', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    alice.stickers.failNextStickerRead('B');
    const page = alice.openPage();
    await page.readTelegram();
    await page.linkSignal();
    await page.run();
    expect(page.entry('B').state).toBe('failed');
    expect(page.entry('B').error).toMatch(/downloading from Telegram failed/);
    expect(await alice.installedTitles()).toEqual(['A', 'C']);
    await page.run();
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C']);
  });

  // Detects: the next pack not being prepared while waiting for Signal's upload limit, which would add its download
  // and conversion time to every wait.
  it('downloads the next pack while waiting for the upload limit', async () => {
    const world = new StickerWorld({ uploadLimit: { burst: 1, intervalMs: UPLOAD_INTERVAL } });
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    let preparedDuringWait = false;
    await alice.visit({
      onChange: (migration) => {
        // B waits for the limit with its stickers ready; C is the next pack.
        const c = migration.entries.find((entry) => entry.pack.title === 'C')!;
        if (migration.uploadAllowedAt !== null && (c.state === 'downloading' || c.state === 'converting'))
          preparedDuringWait = true;
      },
    });
    expect(preparedDuringWait).toBe(true);
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C']);
  });

  // Detects: the migration going on with a device the user unlinked from their phone, sending requests that Signal
  // refuses and marking the remaining packs failed.
  it('stops when the device is unlinked, and a later visit finishes', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    let unlinked = false;
    const page = await alice.visit({
      onChange: (migration, account) => {
        if (!unlinked && migration.entries.some((entry) => entry.state === 'in-signal')) {
          unlinked = true;
          alice.phone.unlink(account.deviceId);
        }
      },
    });
    expect(page.migration.phase).toBe('stopped');
    expect(world.signal.requestsFromUnlinkedDevices).toBe(0);
    expect(page.entry('B').state).toBe('to-upload');
    expect(await alice.installedTitles()).toEqual(['A']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(1);
    await alice.visit();
    expect(await alice.installedTitles()).toEqual(['A', 'B', 'C']);
  });
});

describe('choices', () => {
  // Detects: deselected packs being downloaded, uploaded or installed anyway.
  it('leaves deselected packs alone', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A'), world.pack('B'), world.pack('C')]);
    const page = await alice.visit({ select: (title) => title !== 'B' });
    expect(await alice.installedTitles()).toEqual(['A', 'C']);
    expect(world.signal.packsUploaded.get(alice.aci)).toBe(2);
    expect(page.entry('B').state).toBe('to-upload');
    expect(alice.stickers.stickerReads('B')).toBe(0);
  });

  // Detects: a pack Signal cannot hold (over 200 stickers) being selectable.
  it('does not let a pack of more than 200 stickers be selected', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('Huge', 201), world.pack('A')]);
    const page = alice.openPage();
    await page.readTelegram();
    expect(page.entry('Huge').selected).toBe(false);
    page.migration.setSelected(page.entry('Huge'), true);
    expect(page.entry('Huge').selected).toBe(false);
  });
});
