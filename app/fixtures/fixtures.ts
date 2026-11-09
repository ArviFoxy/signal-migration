// Fixtures for looking at each screen without accounts. Each one builds the real workflow with inert services and
// puts it straight into one state: no change event fires while a fixture is set up, so the workflow starts no
// background work. `?f=<name>` picks the fixture; fixtures/screens.mjs screenshots them all. Built only with
// `node build.mjs --fixtures`, never served.

import type * as Td from 'tdlib-types';
import type { AppServices, LinkedDevice, TelegramSession } from '../src/app/services';
import { type SetupStep, Workflow } from '../src/app/workflow';
import { type PackEntry, type PackState, StickerMigration } from '../src/kinds/stickers/migration';
import type { PackIndex } from '../src/kinds/stickers/pack-index';
import type { StickerFormat } from '../src/kinds/stickers/telegram-packs';
import type { MigrationApp } from '../src/ui/migration-app';
import '../src/ui/migration-app';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const session: TelegramSession = {
  instance: 'fixture',
  invoke: never as unknown as Td.Invoke,
  source: { readPacks: never, readFile: never },
  checkpoint: never,
  logOut: never,
  dispose: never,
};

const device: LinkedDevice = {
  deviceId: 3,
  https: never,
  stored: { aci: 'fixture', deviceId: 3, password: '', storageServiceKey: new Uint8Array(32) },
  onUnlinked: () => undefined,
  isLinked: true,
  withChat: never,
  storage: never,
  announceStickerPacks: never,
  unlink: never,
};

const services: AppServices = {
  telegram: {
    app: never,
    newInstance: () => 'fixture',
    start: () => session,
    instances: async () => [],
    deleteInstance: async () => undefined,
  },
  signal: { link: never, restore: () => device },
  migration: () => ({ clock: { now: () => Date.now(), sleep: never }, convert: never, index: {} as PackIndex }),
  snapshots: { load: async () => null, save: async () => undefined, clear: async () => undefined },
};

const TITLES = [
  'Fox Friends',
  'Sleepy Wolves',
  'Dragon Moods',
  'Otter Chaos',
  'Synth Cats',
  'Bun Reactions',
  'Raccoon Gremlins',
  'Deer Days',
  'A sticker pack with a rather long title that does not fit on one line',
];
const EMOJI = ['🦊', '🐺', '🐉', '🦦', '🐱', '🐰', '🦝', '🦌', '🐸'];
const FORMATS: StickerFormat[] = ['tgs', 'webp', 'webm'];

/** Preview images, drawn once per emoji and variant. */
const previews = new Map<string, Promise<Uint8Array>>();
function preview(emoji: string, variant: number): Promise<Uint8Array> {
  const key = `${emoji}${variant}`;
  if (!previews.has(key)) {
    previews.set(
      key,
      (async () => {
        const canvas = new OffscreenCanvas(96, 96);
        const context = canvas.getContext('2d')!;
        context.fillStyle = ['#F2D8C4', '#CFD8EE', '#D9E8D3', '#EAD3E6'][variant];
        context.beginPath();
        context.roundRect(0, 0, 96, 96, 18);
        context.fill();
        context.font = `${48 + variant * 6}px serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(emoji, 48, 52);
        return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      })(),
    );
  }
  return previews.get(key)!;
}

/** `count` packs in Telegram order, every one selected and waiting to upload. */
async function packs(count: number, withPreviews: boolean): Promise<PackEntry[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, rank) => {
      const round = Math.floor(rank / TITLES.length);
      const title = round === 0 ? TITLES[rank] : `${TITLES[rank % TITLES.length]} ${round + 1}`;
      const emoji = EMOJI[rank % EMOJI.length];
      const stickers = Array.from({ length: 8 + ((rank * 7) % 30) }, (_, i) => ({
        fileId: rank * 1000 + i,
        uniqueId: `fixture-${rank}-${i}`,
        emoji,
        format: FORMATS[rank % FORMATS.length],
        thumbnail: null,
      }));
      return {
        pack: { setId: String(rank + 1), title, stickers },
        rank,
        identity: { sourceId: new Uint8Array(32), lookupKey: new Uint8Array(32) },
        selected: true,
        state: 'to-upload' as PackState,
        packId: null,
        packKey: null,
        thumbnails: withPreviews
          ? await Promise.all([0, 1, 2, 3].map(async (v) => ({ data: await preview(emoji, v), mimeType: 'image/png' })))
          : [],
        prepared: false,
        progress: null,
        conversion: null,
        error: null,
      };
    }),
  );
}

type Fixture = {
  /** Puts the workflow into the fixture's state. */
  set(workflow: Workflow): Promise<void> | void;
  /** One step the user takes once the screen shows (a scroll, for example). */
  then?(app: MigrationApp): void;
};

const signedIn = (w: Workflow) => (w.telegram.state = { kind: 'ready', session });
const linked = (w: Workflow) => (w.signal.state = { kind: 'linked', device });
const setup = (w: Workflow, step: SetupStep) => (w.phase = { kind: 'setup', step });

async function withPacks(w: Workflow, count: number, withPreviews = false): Promise<StickerMigration> {
  const migration = new StickerMigration(services.migration());
  migration.entries = await packs(count, withPreviews);
  migration.lookedUp = true;
  migration.signalReadFrom = device;
  w.stickers = migration;
  return migration;
}

/** The migration of 170 packs, `done` of them in Signal, the next one uploading. */
async function migrating(w: Workflow, done: number): Promise<StickerMigration> {
  signedIn(w);
  linked(w);
  w.phase = { kind: 'migrating' };
  const migration = await withPacks(w, 170);
  migration.phase = 'running';
  migration.entries.forEach((entry, rank) => {
    if (rank < done) entry.state = 'in-signal';
    else if (rank % 3 === 1) entry.state = 'available';
  });
  return migration;
}

const FIXTURES: Record<string, Fixture> = {
  start: { set: (w) => setup(w, 'start') },
  'telegram-qr': {
    set(w) {
      setup(w, 'packs');
      w.telegram.state = {
        kind: 'login',
        auth: { _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=fixture' },
      };
    },
  },
  'telegram-password': {
    set(w) {
      setup(w, 'packs');
      w.telegram.method = 'phone';
      w.telegram.state = {
        kind: 'login',
        auth: {
          _: 'authorizationStateWaitPassword',
          password_hint: 'the usual one',
          has_recovery_email_address: false,
          has_passport_data: false,
          recovery_email_address_pattern: '',
        } as Td.AuthorizationState,
      };
      w.telegram.error = 'PASSWORD_HASH_INVALID';
    },
  },
  'signal-qr': {
    set(w) {
      setup(w, 'packs');
      signedIn(w);
      w.signal.state = { kind: 'linking', qrUrl: 'sgnl://linkdevice?uuid=fixture&pub_key=fixture' };
    },
  },
  'packs-170': {
    async set(w) {
      setup(w, 'packs');
      signedIn(w);
      linked(w);
      const migration = await withPacks(w, 170, true);
      migration.entries.forEach((entry, rank) => {
        if (rank % 3 === 1) entry.state = 'available';
        if (rank % 11 === 5) entry.state = 'in-signal';
        if (rank % 13 === 7) entry.selected = false;
      });
    },
  },
  'review-170': {
    async set(w) {
      setup(w, 'review');
      signedIn(w);
      linked(w);
      const migration = await withPacks(w, 170);
      migration.entries.forEach((entry, rank) => rank % 3 === 1 && (entry.state = 'available'));
    },
  },
  'migrate-uploading': {
    async set(w) {
      const migration = await migrating(w, 40);
      Object.assign(migration.entries[40], { state: 'uploading', progress: { done: 12, total: 20 } });
    },
  },
  'migrate-waiting': {
    async set(w) {
      const migration = await migrating(w, 50);
      migration.uploadAllowedAt = Date.now() + 43 * 60_000 + 12_000;
      Object.assign(migration.entries[51], { state: 'downloading', progress: { done: 5, total: 18 } });
    },
  },
  'migrate-scrolled-away': {
    async set(w) {
      const migration = await migrating(w, 40);
      Object.assign(migration.entries[40], { state: 'uploading', progress: { done: 12, total: 20 } });
    },
    then(app) {
      app.querySelector('ul[aria-label="Packs"]')!.scrollTop = 0;
    },
  },
  'migrate-finished': {
    async set(w) {
      const migration = await migrating(w, 170);
      migration.phase = 'done';
      w.phase = { kind: 'finished' };
      w.telegram.state = { kind: 'off', signedOut: true };
      w.signal.state = { kind: 'off', unlinked: 'at-finish' };
    },
  },
};

declare global {
  interface Window {
    fixtureNames: string[];
  }
}
window.fixtureNames = Object.keys(FIXTURES);

const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const name = new URLSearchParams(location.search).get('f') ?? 'start';
const fixture = FIXTURES[name];
const app = document.querySelector('migration-app') as MigrationApp;
const workflow = new Workflow(services);
await fixture.set(workflow);
app.workflow = workflow;
await app.updateComplete;
await document.fonts.ready;
// QR codes are drawn asynchronously, and the step elements render in the frames after the app.
await frame();
await pause(100);
if (fixture.then) {
  fixture.then(app);
  await pause(250);
}
await frame();
document.body.dataset.ready = 'true';
