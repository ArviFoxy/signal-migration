// Fixtures for looking at each screen without accounts. Each one builds the real workflow and puts it straight into
// one state of the app's state machine. The workflow is not started, so no work runs. `?f=<name>` picks the fixture; fixtures/screens.mjs screenshots them all. Built only with
// `node build.mjs --fixtures`, never served.

import type * as Td from 'tdlib-types';
import type { AppState, SetupStep } from '../src/app/machine/app';
import type { Session } from '../src/app/machine/app/state';
import type { SignalState } from '../src/app/machine/signal';
import type { TelegramState } from '../src/app/machine/telegram';
import type { AppServices, StoredDevice } from '../src/app/services';
import { Workflow } from '../src/app/workflow';
import { type PackEntry, type PackState, StickerMigration } from '../src/kinds/stickers/migration';
import type { PackIndex } from '../src/kinds/stickers/pack-index';
import type { StickerFormat } from '../src/kinds/stickers/telegram-packs';
import type { MigrationApp } from '../src/ui/migration-app';
import '../src/ui/migration-app';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

const device: StoredDevice = { aci: 'fixture', deviceId: 3, password: '', storageServiceKey: new Uint8Array(32) };

// No work runs in a fixture (the workflow is not started), so the services are never called.
const services = {
  migration: () => ({ clock: { now: () => Date.now(), sleep: never }, convert: never, index: {} as PackIndex }),
} as unknown as AppServices;

const signedIn: TelegramState = { kind: 'signed-in', method: 'qr', instance: 'fixture', attempt: 1, error: null };
const notConnected: TelegramState = { kind: 'off', method: 'qr', signedOut: false, error: null };
const linked: SignalState = { kind: 'linked', deviceName: 'Sticker migration', device, error: null, unlinks: 0 };
const notLinked: SignalState = {
  kind: 'off',
  deviceName: 'Sticker migration',
  unlinked: null,
  error: null,
  attempts: 0,
};

const session = (parts: Partial<Session> = {}): Session => ({
  telegram: notConnected,
  signal: notLinked,
  packs: { kind: 'none' },
  deselected: [],
  notice: null,
  ...parts,
});

const setup = (step: SetupStep, parts: Partial<Session> = {}): AppState => ({ ...session(parts), kind: 'setup', step });

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
  /** The state the fixture shows. */
  state(): Promise<AppState> | AppState;
  /** One step the user takes once the screen shows (a scroll, for example). */
  then?(app: MigrationApp): void;
};

async function withPacks(count: number, withPreviews = false): Promise<StickerMigration> {
  const migration = new StickerMigration(services.migration());
  migration.entries = await packs(count, withPreviews);
  migration.lookedUp = true;
  return migration;
}

const read = (migration: StickerMigration): Session['packs'] => ({
  kind: 'read',
  instance: 'fixture',
  attempt: 1,
  migration,
  signalRead: device.deviceId,
  signalError: null,
  signalAttempt: 0,
});

/** The migration of 170 packs, `done` of them in Signal, the next one uploading. */
async function migrating(done: number): Promise<{ state: AppState; migration: StickerMigration }> {
  const migration = await withPacks(170);
  migration.phase = 'running';
  migration.entries.forEach((entry, rank) => {
    if (rank < done) entry.state = 'in-signal';
    else if (rank % 3 === 1) entry.state = 'available';
  });
  const state: AppState = {
    ...session({ telegram: signedIn, signal: linked, packs: read(migration) }),
    kind: 'migrating',
    run: { attempt: 1, status: 'running', error: null },
  };
  return { state, migration };
}

const FIXTURES: Record<string, Fixture> = {
  start: { state: () => setup('start') },
  'telegram-qr': {
    state: () =>
      setup('packs', {
        telegram: {
          kind: 'login',
          method: 'qr',
          instance: 'fixture',
          attempt: 1,
          auth: { _: 'authorizationStateWaitOtherDeviceConfirmation', link: 'tg://login?token=fixture' },
          request: null,
          sent: 1,
          qrRequested: true,
          error: null,
        },
      }),
  },
  'telegram-password': {
    state: () =>
      setup('packs', {
        telegram: {
          kind: 'login',
          method: 'phone',
          instance: 'fixture',
          attempt: 1,
          auth: {
            _: 'authorizationStateWaitPassword',
            password_hint: 'the usual one',
            has_recovery_email_address: false,
            has_passport_data: false,
            recovery_email_address_pattern: '',
          } as Td.AuthorizationState,
          request: null,
          sent: 3,
          qrRequested: false,
          error: 'PASSWORD_HASH_INVALID',
        },
      }),
  },
  'telegram-stopped': {
    state: () =>
      setup('packs', {
        telegram: {
          kind: 'stopped',
          method: 'qr',
          instance: 'fixture',
          attempt: 1,
          error: "Telegram's library did not start within 60 seconds.",
        },
      }),
  },
  'signal-qr': {
    state: () =>
      setup('packs', {
        telegram: signedIn,
        signal: {
          kind: 'linking',
          deviceName: 'Sticker migration',
          attempt: 1,
          qrUrl: 'sgnl://linkdevice?uuid=fixture&pub_key=fixture',
        },
      }),
  },
  'packs-170': {
    async state() {
      const migration = await withPacks(170, true);
      migration.entries.forEach((entry, rank) => {
        if (rank % 3 === 1) entry.state = 'available';
        if (rank % 11 === 5) entry.state = 'in-signal';
        if (rank % 13 === 7) entry.selected = false;
      });
      return setup('packs', { telegram: signedIn, signal: linked, packs: read(migration) });
    },
  },
  'review-170': {
    async state() {
      const migration = await withPacks(170);
      migration.entries.forEach((entry, rank) => rank % 3 === 1 && (entry.state = 'available'));
      return setup('review', { telegram: signedIn, signal: linked, packs: read(migration) });
    },
  },
  'migrate-uploading': {
    async state() {
      const { state, migration } = await migrating(40);
      Object.assign(migration.entries[40], { state: 'uploading', progress: { done: 12, total: 20 } });
      return state;
    },
  },
  'migrate-waiting': {
    async state() {
      const { state, migration } = await migrating(50);
      migration.uploadAllowedAt = Date.now() + 43 * 60_000 + 12_000;
      Object.assign(migration.entries[51], { state: 'downloading', progress: { done: 5, total: 18 } });
      return state;
    },
  },
  'migrate-scrolled-away': {
    async state() {
      const { state, migration } = await migrating(40);
      Object.assign(migration.entries[40], { state: 'uploading', progress: { done: 12, total: 20 } });
      return state;
    },
    then(app) {
      app.querySelector('ul[aria-label="Packs"]')!.scrollTop = 0;
    },
  },
  'migrate-finished': {
    async state() {
      const { migration } = await migrating(170);
      migration.phase = 'done';
      return {
        ...session({
          telegram: { kind: 'off', method: 'qr', signedOut: true, error: null },
          signal: { ...notLinked, unlinked: 'at-finish' },
          packs: read(migration),
        }),
        kind: 'done',
      };
    },
  },
  'end-failed': {
    async state() {
      const { migration } = await migrating(170);
      return {
        ...session({
          telegram: {
            ...signedIn,
            error: 'Signing out of Telegram failed: Telegram did not answer within 60 seconds.',
          },
          signal: { ...linked, error: 'Unlinking Signal failed: Signal did not answer within 60 seconds.' },
          packs: read(migration),
        }),
        kind: 'end-failed',
        reason: 'finish',
        telegramError: 'Signing out of Telegram failed: Telegram did not answer within 60 seconds.',
        signalError: 'Unlinking Signal failed: Signal did not answer within 60 seconds.',
      };
    },
  },
  elsewhere: { state: () => ({ kind: 'elsewhere' }) },
  'load-failed': {
    state: () => ({
      kind: 'load-failed',
      error: 'Your browser could not read the saved migration: the database is blocked',
      attempt: 1,
    }),
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
workflow.state = await fixture.state();
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
