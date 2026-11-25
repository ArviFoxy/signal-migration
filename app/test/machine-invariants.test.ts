// State-machine regressions & structural invariants: reload consistency, cancellation of background work,
// cross-account DeviceKey isolation, work-owned SignalConnection disposal, telegram/fatal & CLOSED_STATES handling,
// and pure-machine reachability / reload-at-every-phase invariants.

import { describe, expect, it } from 'vitest';
import { appTransition, appWork, isSession, recordOf, type AppState } from '../src/app/machine/app';
import { fromRecord } from '../src/app/machine/app/loading';
import { settle } from '../src/app/machine/app/settle';
import type { Context } from '../src/app/machine/core';
import { initialSignal, signalTransition } from '../src/app/machine/signal';
import { initialTelegram, telegramTransition, type TelegramState } from '../src/app/machine/telegram';
import { Workflow } from '../src/app/workflow';
import type { FriendSource } from '../src/kinds/friends/search';
import type { PeopleSource } from '../src/kinds/friends/telegram-people';
import { appServices, Browser } from './scenario/stickers/app-services';
import { StickerWorld } from './scenario/stickers/sticker-world';

let nonceCounter = 0;
const nextContext = (): Context => ({ nonce: (++nonceCounter).toString(16).padStart(16, '0') });

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${what}: never happened`);
}

describe('Telegram sub-machine fatal & auth transitions', () => {
  const baseRunning = {
    method: 'phone' as const,
    instance: 'telegram-0000000000000001',
    attempt: 1,
  };

  // Detects: telegram/fatal (restarted: false) silently ignored in saving, signed-in, signing-out, ending-by-itself,
  // and authorizationStateClosed silently ignored in signing-out (causing 60s hangs or permanent wedging).
  it('handles non-restarted telegram/fatal in saving, signed-in, signing-out, and ending-by-itself', () => {
    const fatal = { type: 'telegram/fatal' as const, error: 'Aborted()', restarted: false };

    const fromSaving = telegramTransition({ ...baseRunning, kind: 'saving' }, fatal, nextContext());
    expect(fromSaving.kind).toBe('stopped');

    const fromSignedIn = telegramTransition({ ...baseRunning, kind: 'signed-in', error: null }, fatal, nextContext());
    expect(fromSignedIn.kind).toBe('stopped');

    const fromSigningOut = telegramTransition({ ...baseRunning, kind: 'signing-out' }, fatal, nextContext());
    expect(fromSigningOut.kind).toBe('stopped');

    const fromEnding = telegramTransition(
      { ...baseRunning, kind: 'ending-by-itself', byTelegram: true },
      fatal,
      nextContext(),
    );
    expect(fromEnding.kind).toBe('deleting');
    if (fromEnding.kind === 'deleting') expect(fromEnding.signedOut).toBe(true);
  });

  it('finishes signing-out immediately when Telegram closes the session remotely', () => {
    const next = telegramTransition(
      { ...baseRunning, kind: 'signing-out' },
      { type: 'telegram/auth', auth: { _: 'authorizationStateClosed' } },
      nextContext(),
    );
    expect(next.kind).toBe('deleting');
    if (next.kind === 'deleting') expect(next.signedOut).toBe(true);
  });

  // Detects: switching from phone to qr while a phone request is in flight leaving qr mode with request === null
  // forever after telegram/request-done arrives.
  it('requests a QR code on telegram/request-done if the user switched to QR while a request was in flight', () => {
    const inFlight: TelegramState = {
      kind: 'login',
      method: 'phone',
      instance: 'telegram-0000000000000001',
      attempt: 1,
      auth: { _: 'authorizationStateWaitPhoneNumber' },
      request: { _: 'setAuthenticationPhoneNumber', phone_number: '+12025550101' },
      sent: 1,
      qrRequested: false,
      error: null,
    };
    const switched = telegramTransition(inFlight, { type: 'telegram/use-method', method: 'qr' }, nextContext());
    expect(switched.kind).toBe('login');
    const afterDone = telegramTransition(switched, { type: 'telegram/request-done' }, nextContext());
    expect(afterDone.kind).toBe('login');
    if (afterDone.kind === 'login') {
      expect(afterDone.request).toEqual({ _: 'requestQrCodeAuthentication', other_user_ids: [] });
      expect(afterDone.qrRequested).toBe(true);
    }
  });
});

describe('App session transitions and notices', () => {
  // Detects: signal/unlinked-from-phone clearing the Signal device without setting a user-facing notice.
  it('sets a notice when Signal is unlinked from the phone', () => {
    const linkedDevice = {
      aci: 'account-a',
      deviceId: 2,
      password: 'p',
      storageServiceKey: new Uint8Array(32).fill(1),
      identityPublic: new Uint8Array(33),
      identityPrivate: new Uint8Array(32),
      registrationId: 1,
    };
    const state: AppState = {
      kind: 'setup',
      step: 'review',
      telegram: { kind: 'signed-in', method: 'qr', instance: 'telegram-1', attempt: 1, error: null },
      signal: signalTransition(
        signalTransition(initialSignal('Browser'), { type: 'signal/link' }, nextContext()),
        { type: 'signal/linked', device: linkedDevice },
        nextContext(),
      ),
      chosen: { stickers: true, friends: false, saved: false },
      packs: { kind: 'none' },
      deselected: [],
      friends: { kind: 'none' },
      tickedFriends: [],
      saved: { kind: 'none' },
      savedFrom: null,
      savedSentUpTo: null,
      notice: null,
    };
    const next = appTransition(state, { type: 'signal/unlinked-from-phone' }, nextContext());
    expect(isSession(next) && next.notice).toMatch(/unlinked/i);
  });

  // Detects: copy-saved-from with the same date wiping savedSentUpTo back to null.
  it('preserves savedSentUpTo when copy-saved-from is dispatched with the same cutoff', () => {
    const state: AppState = {
      kind: 'setup',
      step: 'saved',
      telegram: initialTelegram,
      signal: initialSignal('Browser'),
      chosen: { stickers: false, friends: false, saved: true },
      packs: { kind: 'none' },
      deselected: [],
      friends: { kind: 'none' },
      tickedFriends: [],
      saved: { kind: 'none' },
      savedFrom: 1_700_000_000,
      savedSentUpTo: 42,
      notice: null,
    };
    const next = appTransition(state, { type: 'copy-saved-from', from: 1_700_000_000 }, nextContext());
    expect(isSession(next) && next.savedSentUpTo).toBe(42);
  });

  // Detects: run/friends-failed leaving run.savedWait non-null after copy-saved is aborted, keeping a 1 s UI ticker alive.
  it('clears savedWait when run/friends-failed stops the migration', () => {
    const linkedDevice = {
      aci: 'account-a',
      deviceId: 2,
      password: 'p',
      storageServiceKey: new Uint8Array(32).fill(1),
      identityPublic: new Uint8Array(33),
      identityPrivate: new Uint8Array(32),
      registrationId: 1,
    };
    const state: AppState = {
      kind: 'migrating',
      telegram: { kind: 'signed-in', method: 'qr', instance: 'telegram-1', attempt: 1, error: null },
      signal: signalTransition(
        signalTransition(initialSignal('Browser'), { type: 'signal/link' }, nextContext()),
        { type: 'signal/linked', device: linkedDevice },
        nextContext(),
      ),
      chosen: { stickers: false, friends: true, saved: true },
      packs: { kind: 'none' },
      deselected: [],
      friends: { kind: 'none' },
      tickedFriends: [],
      saved: { kind: 'none' },
      savedFrom: null,
      savedSentUpTo: null,
      notice: null,
      run: {
        attempt: 1,
        status: 'running',
        friendsAdded: null,
        error: null,
        savedWait: { service: 'Signal', until: Date.now() + 30_000 },
      },
    };
    const next = appTransition(state, { type: 'run/friends-failed', error: 'storage conflict' }, nextContext());
    expect(next.kind).toBe('migrating');
    if (next.kind === 'migrating') {
      expect(next.run.status).toBe('failed');
      expect(next.run.savedWait).toBeNull();
    }
  });
});

describe('Workflow invariants: reload, cancellation, cross-account isolation, and disposal', () => {
  // Detects: Workflow.migrationRun.completed reporting true while friends is still 'looking' after reload in migrating.
  it('does not report migrationRun.completed while friends are still loading after reload during migrating', () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    const page = appServices(alice, new Browser());
    const workflow = new Workflow(page.services);
    const linked = alice.linkDevice();
    const reloaded = settle(
      fromRecord(
        {
          version: 5,
          phase: 'migrating',
          step: 'review',
          why: null,
          telegram: 'telegram-0000000000000001',
          signal: {
            aci: alice.aci,
            deviceId: linked.deviceId,
            password: 'simulated',
            storageServiceKey: linked.storageServiceKey,
            identityPublic: new Uint8Array(33),
            identityPrivate: new Uint8Array(32),
            registrationId: 1,
          },
          chosen: { stickers: false, friends: true, saved: false },
          deselected: [],
          tickedFriends: [2],
          savedFrom: null,
          savedSentUpTo: null,
        },
        nextContext(),
      ),
      nextContext(),
    );
    (workflow as unknown as { state: AppState }).state = reloaded;
    expect(reloaded.kind).toBe('migrating');
    expect(workflow.migrationRun.completed).toBe(false);
    expect(workflow.migrationRun.ended).toBe(false);
  });

  // Detects: opting out of Friends while readPeople is running leaving findFriends running into discoverAccounts.
  it('aborts find-friends immediately when the user unchecks Friends before contact discovery runs', async () => {
    const world = new StickerWorld();
    const alice = world.user([]);
    let abortedSignal: AbortSignal | undefined;
    let releaseReadPeople!: () => void;
    let readPeopleStarted!: () => void;
    const started = new Promise<void>((r) => (readPeopleStarted = r));
    let discoverCalled = false;

    const people: PeopleSource = {
      async readPeople(_onProgress, cancel) {
        abortedSignal = cancel;
        readPeopleStarted();
        await new Promise<void>((resolve) => {
          releaseReadPeople = resolve;
          cancel?.addEventListener('abort', () => resolve(), { once: true });
        });
        cancel?.throwIfAborted();
        return {
          chats: [{ kind: 'person', userId: 2 }],
          contactIds: [],
          people: new Map([[2, { userId: 2, givenName: 'Mara', familyName: '', phoneNumber: '+12025550102' }]]),
        };
      },
      readPhoto: async () => new Uint8Array(),
    };
    const friendSources: FriendSource[] = [
      {
        async find() {
          discoverCalled = true;
          return new Map();
        },
      },
    ];

    const page = appServices(alice, new Browser(), { people, friendSources });
    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => isSession(workflow.state), 'loaded');
    workflow.choose('stickers', false);
    workflow.choose('friends', true);
    workflow.goTo('friends');
    await until(() => page.scanTelegramCode(), 'telegram qr');
    await until(() => page.scanSignalCode(), 'signal qr');
    await started;

    // User opts out of Friends before readPeople finishes.
    workflow.choose('friends', false);
    releaseReadPeople();
    await new Promise((r) => setTimeout(r, 30));

    expect(abortedSignal?.aborted).toBe(true);
    expect(discoverCalled).toBe(false);
  });

  // Detects: forgetting a Signal device in end-failed never calling device.dispose() (leaking sockets and secrets).
  it('calls device.dispose() when the user clicks Forget it on a Signal device whose unlink failed', async () => {
    const world = new StickerWorld();
    const alice = world.user([world.pack('A')]);
    const page = appServices(alice, new Browser());
    let disposed = 0;
    const origLink = page.services.signal.link;
    page.services.signal.link = async (...args) => {
      const device = await origLink(...args);
      const origDispose = device.dispose.bind(device);
      device.dispose = () => {
        disposed++;
        origDispose();
      };
      return device;
    };

    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => isSession(workflow.state), 'loaded');
    workflow.goTo('packs');
    await until(() => page.scanTelegramCode(), 'telegram qr');
    await until(() => page.scanSignalCode(), 'signal qr');
    await until(() => workflow.step === 'packs' && workflow.packsReady, 'packs ready');

    world.signal.failUnlinks = 10;
    workflow.clear();
    await until(() => workflow.state.kind === 'end-failed', 'end-failed');
    expect(disposed).toBe(0);
    workflow.forget('signal');
    await until(() => workflow.state.kind === 'setup', 'back to start');
    expect(disposed).toBe(1);
  });

  // Detects: unlinking Account A (deviceId 2) and linking Account B (also deviceId 2) reusing Account A's
  // packs.signalRead === 2 and skipping reading Account B's Signal packs.
  it('re-reads Signal packs when switching from one Signal account to another that also gets deviceId 2', async () => {
    const world = new StickerWorld();
    const packA = world.pack('A');
    const alice = world.user([packA]);
    // Alice already has pack A installed on Signal (uploaded first).
    await alice.visit();
    // Bob is a second Signal account whose linked device gets the exact same deviceId (3) as Alice's, with NO packs.
    const bob = world.user([packA]);
    bob.phone.unlink(bob.linkDevice().deviceId);

    const page = appServices(alice, new Browser());
    let nextLinkUser: 'alice' | 'bob' = 'alice';
    const origLink = page.services.signal.link;
    const bobPage = appServices(bob, new Browser());
    page.services.signal.link = async (showQr, deviceName, cancel) => {
      if (nextLinkUser === 'alice') return origLink(showQr, deviceName, cancel);
      const promise = bobPage.services.signal.link(showQr, deviceName, cancel);
      await until(() => bobPage.scanSignalCode(), 'bob signal qr');
      return promise;
    };

    const workflow = new Workflow(page.services);
    workflow.start();
    await until(() => isSession(workflow.state), 'loaded');
    workflow.goTo('packs');
    await until(() => page.scanTelegramCode(), 'telegram qr');
    await until(() => page.scanSignalCode(), 'alice signal qr');
    await until(() => workflow.step === 'packs' && workflow.packsReady, 'alice packs ready');
    expect(workflow.stickers!.entries[0].state).toBe('in-signal');

    // Unlink Alice's Signal device and link Bob's Signal device (which has the exact same deviceId!).
    // Note: unlinking on the Packs step immediately returns to the Signal step and starts linking again.
    nextLinkUser = 'bob';
    const aliceDevice = workflow.signal.device;
    workflow.unlinkSignal();
    await until(() => workflow.signal.state.kind === 'linked' && workflow.signal.device?.aci === bob.aci, 'bob linked');
    expect(workflow.signal.device?.deviceId).toBe(aliceDevice?.deviceId);
    await until(() => workflow.packsReady, 'bob packs read');

    // Pack A must NOT remain marked 'in-signal' from Alice's account!
    expect(workflow.stickers!.entries[0].state).not.toBe('in-signal');
  });

  // Structural invariant: signal-device work is described if and only if signal is linked or unlinking, across reloads.
  it('maintains the signal-device work invariant across reloads of every phase', () => {
    const device = {
      aci: 'account-a',
      deviceId: 2,
      password: 'p',
      storageServiceKey: new Uint8Array(32).fill(1),
      identityPublic: new Uint8Array(33),
      identityPrivate: new Uint8Array(32),
      registrationId: 1,
    };
    const phases: ('setup' | 'migrating' | 'ending')[] = ['setup', 'migrating', 'ending'];
    for (const phase of phases) {
      for (const signal of [null, device]) {
        const state = settle(
          fromRecord(
            {
              version: 5,
              phase,
              step: 'review',
              why: phase === 'ending' ? 'finish' : null,
              telegram: 'telegram-0000000000000001',
              signal,
              chosen: { stickers: true, friends: true, saved: true },
              deselected: [],
              tickedFriends: [],
              savedFrom: null,
              savedSentUpTo: null,
            },
            nextContext(),
          ),
          nextContext(),
        );
        const work = appWork(state);
        const hasSignalDeviceWork = work.some((w) => w.kind === 'signal-device');
        const hasKeptSignal = isSession(state) && (state.signal.kind === 'linked' || state.signal.kind === 'unlinking');
        expect(hasSignalDeviceWork, `phase=${phase} signal=${Boolean(signal)}`).toBe(hasKeptSignal);
        // Round-tripping recordOf must not throw.
        recordOf(state);
      }
    }
  });
});
