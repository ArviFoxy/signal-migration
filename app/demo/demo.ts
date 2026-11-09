// A demo of the wizard with simulated Telegram and Signal accounts, for looking at every screen without real
// accounts. The wizard, the migration and the storage, index and upload code are the app's own; Telegram, Signal's
// servers, the index server and the sticker conversion are the scenario framework's simulations, with delays added.
// Built only with `node build.mjs --demo`.

import type * as Td from 'tdlib-types';
import { systemClock } from '../src/core/clock';
import type { ConvertSticker } from '../src/kinds/stickers/convert';
import { packIdentity } from '../src/kinds/stickers/identity';
import { PackIndex } from '../src/kinds/stickers/pack-index';
import type { StickerFormat, TelegramPack, TelegramSource } from '../src/kinds/stickers/telegram-packs';
import { uploadStickerPack } from '../src/kinds/stickers/upload';
import { StorageClient } from '../src/signal/storage';
import type { ChatChannel, HttpsRequest } from '../src/signal/transport';
import { loadSignalWasm } from '../src/signal/wasm';
import { storageServiceKeyFromMasterKey } from '../src/wasm/signal_migration_wasm';
import type { MigrationApp } from '../src/ui/migration-app';
import '../src/ui/migration-app';
import type { AppServices, LinkedDevice, SnapshotStore } from '../src/app/services';
import { LinkingCancelledError } from '../src/signal/link';
import { type Snapshot, Workflow } from '../src/app/workflow';
import { connectRouter } from '../src/ui/router';
import { FakeSignal } from '../test/scenario/fake-signal';
import { contactRecord, initialStorage } from '../test/scenario/storage-builder';
import { FakeIndex } from '../test/scenario/stickers/fake-index';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_PACKS: { title: string; emoji: string; colour: string; format: StickerFormat; count: number }[] = [
  { title: 'Fox Friends', emoji: '🦊', colour: '#F2D8C4', format: 'tgs', count: 12 },
  { title: 'Sleepy Wolves', emoji: '🐺', colour: '#CFD8EE', format: 'webp', count: 8 },
  { title: 'Dragon Moods', emoji: '🐉', colour: '#D9E8D3', format: 'tgs', count: 10 },
  { title: 'Otter Chaos', emoji: '🦦', colour: '#EAD3E6', format: 'webm', count: 6 },
  { title: 'Synth Cats', emoji: '🐱', colour: '#F6E6D8', format: 'webm', count: 9 },
  { title: 'Bun Reactions', emoji: '🐰', colour: '#DCE3F4', format: 'webp', count: 14 },
  { title: 'Raccoon Gremlins', emoji: '🦝', colour: '#E6F0E2', format: 'tgs', count: 7 },
  { title: 'Deer Days', emoji: '🦌', colour: '#F2E3EF', format: 'webp', count: 5 },
];
/** How many packs the demo account has: `?packs=170` in the address, otherwise the eight above. */
const PACK_COUNT = Number(new URLSearchParams(location.search).get('packs')) || BASE_PACKS.length;
const PACKS = Array.from({ length: PACK_COUNT }, (_, i) => {
  const base = BASE_PACKS[i % BASE_PACKS.length];
  const round = Math.floor(i / BASE_PACKS.length);
  return { ...base, title: round === 0 ? base.title : `${base.title} ${round + 1}`, count: base.count + (round % 5) };
});
/** Packs that other people already migrated, so that they are on Signal before the demo starts: every third. */
const ALREADY_UPLOADED = new Set(PACKS.filter((_, i) => i % 3 === 1).map((pack) => pack.title));

/** Sticker images are drawn once per emoji, colour and size, then reused. */
const images = new Map<string, Promise<Uint8Array>>();
function stickerImage(emoji: string, colour: string, n: number): Promise<Uint8Array> {
  const key = `${emoji}${colour}${n % 3}`;
  if (!images.has(key)) images.set(key, drawSticker(emoji, colour, n));
  return images.get(key)!;
}

async function drawSticker(emoji: string, colour: string, n: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(128, 128);
  const context = canvas.getContext('2d')!;
  context.fillStyle = colour;
  context.beginPath();
  context.roundRect(0, 0, 128, 128, 24);
  context.fill();
  context.font = `${64 + (n % 3) * 8}px serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(emoji, 64, 70);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/** The demo's Telegram account: the packs above, with a file per sticker. */
async function telegramData(): Promise<{ packs: TelegramPack[]; files: Map<number, Uint8Array> }> {
  const files = new Map<number, Uint8Array>();
  let nextFileId = 1;
  const packs = await Promise.all(
    PACKS.map(async (spec, setIndex) => ({
      setId: String(setIndex + 1),
      title: spec.title,
      stickers: await Promise.all(
        Array.from({ length: spec.count }, async (_, n) => {
          const image = await stickerImage(spec.emoji, spec.colour, n);
          const fileId = nextFileId++;
          files.set(fileId, image);
          return {
            fileId,
            uniqueId: `demo-${spec.title}-${n}`,
            emoji: spec.emoji,
            format: spec.format,
            thumbnail: { fileId, mimeType: 'image/png' },
          };
        }),
      ),
    })),
  );
  return { packs, files };
}

const convert: ConvertSticker = async (file, format) => {
  await delay(60);
  return {
    image: file,
    animation: format === 'webp' ? null : { size: 384, frameRate: 30, sourceFrameRate: format === 'tgs' ? 60 : null },
    reencoded: false,
  };
};

async function setUp(): Promise<AppServices> {
  await loadSignalWasm();
  // The publisher of earlier uploads has no upload limit; the user's account gets a small one, so that the wait
  // for Signal's limit shows within a minute.
  const signal = new FakeSignal(systemClock, { burst: Infinity, intervalMs: 30_000 });
  const index = new FakeIndex(systemClock);
  const { packs, files } = await telegramData();

  const slowChat = (chat: ChatChannel): ChatChannel => ({
    request: async (...args) => (await delay(120), chat.request(...args)),
  });
  const slowHttps: HttpsRequest = async (...args) => (await delay(80), signal.https(...args));

  const publisher = signal.chat(signal.createAccount(), 1);
  for (const pack of packs.filter((candidate) => ALREADY_UPLOADED.has(candidate.title))) {
    const identity = await packIdentity(pack);
    const stickers = pack.stickers.map((sticker) => ({ image: files.get(sticker.fileId)!, emoji: sticker.emoji }));
    const packId = await uploadStickerPack(
      publisher,
      { title: pack.title, stickers },
      identity.packKey,
      undefined,
      signal.https,
    );
    await index.backend.add(new Uint8Array([...identity.lookupKey, ...packId]));
  }

  signal.uploadLimit = { burst: 3, intervalMs: 30_000 };
  const aci = signal.createAccount();
  const masterKey = crypto.getRandomValues(new Uint8Array(32));
  const seeded = initialStorage(masterKey, crypto.getRandomValues(new Uint8Array(32)), [
    contactRecord('Contact 1'),
    contactRecord('Contact 2'),
  ]);
  signal.seedStorage(aci, seeded.version, seeded.manifest, seeded.items);

  const source: TelegramSource = {
    readPacks: async (onProgress) => {
      for (let done = 0; done <= packs.length; done++) {
        onProgress(done, packs.length);
        await delay(120);
      }
      return structuredClone(packs);
    },
    readFile: async (fileId) => (await delay(120), files.get(fileId)!.slice()),
  };

  /** The demo's linked device: the app's storage client over the simulated Signal service. */
  const deviceFor = (deviceId: number): LinkedDevice => {
    const chat = slowChat(signal.chat(aci, deviceId));
    const storageServiceKey = storageServiceKeyFromMasterKey(masterKey);
    const device: LinkedDevice = {
      deviceId,
      https: slowHttps,
      stored: { aci, deviceId, password: 'demo', storageServiceKey },
      onUnlinked: () => undefined,
      get isLinked() {
        return signal.isLinked(aci, deviceId);
      },
      withChat: (action) => action(chat),
      storage: () => StorageClient.open(chat, storageServiceKey, deviceId, slowHttps),
      async unlink() {
        await delay(300);
        signal.unlinkDevice(aci, deviceId);
        device.onUnlinked();
      },
    };
    return device;
  };

  let instances = 0;
  return {
    telegram: {
      app: async () => ({ apiId: 0, apiHash: 'demo' }),
      newInstance: () => `demo-${++instances}`,
      start(_app, instance, onAuthorizationState) {
        const set = (state: object) => onAuthorizationState(state as Td.AuthorizationState);
        setTimeout(() => set({ _: 'authorizationStateWaitPhoneNumber' }), 500);
        return {
          instance,
          invoke: (async (query: { _: string }) => {
            await delay(300);
            if (query._ === 'requestQrCodeAuthentication') {
              set({ _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=demo' });
              setTimeout(() => set({ _: 'authorizationStateReady' }), 4000);
            } else if (query._ === 'setAuthenticationPhoneNumber') {
              set({
                _: 'authorizationStateWaitCode',
                code_info: { phone_number: (query as { phone_number?: string }).phone_number ?? '' },
              });
            } else if (query._ === 'checkAuthenticationCode') {
              set({ _: 'authorizationStateReady' });
            } else {
              throw new Error(`the demo does not simulate ${query._}`);
            }
            return { _: 'ok' };
          }) as unknown as Td.Invoke,
          source,
          checkpoint: async () => undefined,
          logOut: () => delay(300).then(() => undefined),
          dispose: async () => undefined,
        };
      },
      instances: async () => [],
      deleteInstance: async () => undefined,
    },
    signal: {
      async link(showQrCode, _deviceName, cancel) {
        showQrCode('sgnl://linkdevice?uuid=demo&pub_key=demo');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 4000);
          cancel.addEventListener('abort', () => (clearTimeout(timer), reject(new LinkingCancelledError())));
        });
        return deviceFor(signal.linkDevice(aci));
      },
      restore: (stored) => deviceFor(stored.deviceId),
    },
    snapshots,
    migration: () => ({
      clock: systemClock,
      convert,
      index: new PackIndex(index.backend, signal.manifestSource, index.pageSize),
    }),
  };
}

/** The demo keeps its snapshot in memory: its simulated accounts do not survive a reload either. */
let kept: Snapshot | null = null;
const snapshots: SnapshotStore = {
  load: async () => kept,
  save: async (snapshot) => void (kept = snapshot),
  clear: async () => void (kept = null),
};

/**
 * The demo's services as soon as the page loads; each call waits for the setup, and fails with its error. The
 * workflow asks for the Telegram app identity before anything else, so the setup is done by any later call.
 */
function servicesAfter(setup: Promise<AppServices>): AppServices {
  let ready: AppServices | null = null;
  void setup.then((services) => (ready = services));
  const settled = () => {
    if (!ready) throw new Error('the demo is still setting up');
    return ready;
  };
  return {
    telegram: {
      app: async () => (await setup).telegram.app(),
      newInstance: () => settled().telegram.newInstance(),
      start: (...args) => settled().telegram.start(...args),
      instances: async () => [],
      deleteInstance: async () => undefined,
    },
    signal: {
      link: async (...args) => (await setup).signal.link(...args),
      restore: (stored) => settled().signal.restore(stored),
    },
    migration: () => settled().migration(),
    snapshots,
  };
}

const setup = setUp();
setup.catch((error) => console.error('the demo could not set up', error));
const workflow = new Workflow(servicesAfter(setup));
(document.querySelector('migration-app') as MigrationApp).workflow = workflow;
void workflow.load().then(() => connectRouter(workflow));
