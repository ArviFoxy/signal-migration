// Tests for the URL hash router (src/ui/router.ts): ensures history is never clobbered during startup loading and
// only user-driven navigation pushes browser history entries.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState, SetupStep } from '../src/app/machine/app';
import type { Session } from '../src/app/machine/app/state';
import type { SignalState } from '../src/app/machine/signal';
import type { TelegramState } from '../src/app/machine/telegram';
import type { AppServices, StoredDevice } from '../src/app/services';
import { Workflow } from '../src/app/workflow';
import { connectRouter } from '../src/ui/router';

type HistoryCall = { kind: 'push' | 'replace'; url: string };

const device: StoredDevice = { aci: 'router-test', deviceId: 3, password: '', storageServiceKey: new Uint8Array(32) };
const signedIn: TelegramState = { kind: 'signed-in', method: 'qr', instance: 'inst-1', attempt: 1, error: null };
const linked: SignalState = {
  kind: 'linked',
  deviceName: 'Sticker migration',
  deviceKey: 'router-test:3:0',
  device,
  error: null,
  unlinks: 0,
};
const notLinked: SignalState = {
  kind: 'off',
  deviceName: 'Sticker migration',
  unlinked: 'from-phone',
  error: null,
  attempts: 0,
};

const session = (parts: Partial<Session> = {}): Session => ({
  telegram: signedIn,
  signal: linked,
  chosen: { stickers: true, friends: false, saved: false },
  packs: { kind: 'none' },
  deselected: [],
  friends: { kind: 'none' },
  tickedFriends: [],
  saved: { kind: 'none' },
  savedFrom: null,
  savedSentUpTo: null,
  notice: null,
  ...parts,
});

const setup = (step: SetupStep, parts: Partial<Session> = {}): AppState => ({ ...session(parts), kind: 'setup', step });

const fakeServices = {} as AppServices;

class FakeBrowserEnv {
  readonly calls: HistoryCall[] = [];
  readonly win = new EventTarget();
  readonly loc = { hash: '' };
  readonly hist = {
    pushState: (_state: unknown, _title: string, url?: string | URL | null) => {
      const text = String(url ?? '');
      this.loc.hash = text.startsWith('#') ? text : '';
      this.calls.push({ kind: 'push', url: text });
    },
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
      const text = String(url ?? '');
      this.loc.hash = text.startsWith('#') ? text : '';
      this.calls.push({ kind: 'replace', url: text });
    },
  };

  setState(workflow: Workflow, next: AppState): void {
    workflow.state = next;
    workflow.dispatchEvent(new Event('change'));
  }

  pop(hash: string): void {
    this.loc.hash = hash;
    this.win.dispatchEvent(new Event('popstate'));
  }
}

describe('connectRouter', () => {
  const originalWindow = globalThis.window;
  const originalHistory = globalThis.history;
  const originalLocation = globalThis.location;
  let env: FakeBrowserEnv;

  beforeEach(() => {
    env = new FakeBrowserEnv();
    Object.defineProperty(globalThis, 'window', { value: env.win, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'history', { value: env.hist, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', { value: env.loc, configurable: true, writable: true });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'history', { value: originalHistory, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true, writable: true });
  });

  it('does not clobber the hash while locking/loading and replaces without pushing on initial settle', () => {
    env.loc.hash = '#/migrate';
    const workflow = new Workflow(fakeServices);
    expect(workflow.state.kind).toBe('locking');

    connectRouter(workflow);

    // Must not overwrite #/migrate with #/start before loading completes.
    expect(env.loc.hash).toBe('#/migrate');
    expect(env.calls).toEqual([]);

    env.setState(workflow, { kind: 'loading', record: undefined, attempt: 1 });
    expect(env.loc.hash).toBe('#/migrate');
    expect(env.calls).toEqual([]);

    // Reloading into an active migration keeps #/migrate with zero pushState entries.
    env.setState(workflow, {
      ...session(),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', friendsAdded: null, error: null },
    });
    expect(env.loc.hash).toBe('#/migrate');
    expect(env.calls.filter((call) => call.kind === 'push')).toEqual([]);
  });

  it('uses replaceState (not pushState) when settling from loading into a different step or clearing', () => {
    env.loc.hash = '#/packs';
    const workflow = new Workflow(fakeServices);
    connectRouter(workflow);

    env.setState(workflow, { kind: 'loading', record: undefined, attempt: 1 });
    // Restored into review after loading: should replace, not push a bogus #/start entry.
    env.setState(workflow, setup('review'));
    expect(env.loc.hash).toBe('#/review');
    expect(env.calls).toEqual([{ kind: 'replace', url: '#/review' }]);

    env.calls.length = 0;
    // Automatic ending -> setup after clear must replace, never push.
    env.setState(workflow, { ...session(), kind: 'ending', reason: 'clear' });
    env.setState(workflow, setup('start'));
    expect(env.loc.hash).toBe('#/start');
    expect(env.calls.filter((call) => call.kind === 'push')).toEqual([]);
  });

  it('pushes on user navigation and replaces on automatic step changes', () => {
    env.loc.hash = '';
    const workflow = new Workflow(fakeServices);
    connectRouter(workflow);

    env.setState(workflow, setup('start'));
    expect(env.calls).toEqual([{ kind: 'replace', url: '#/start' }]);

    env.calls.length = 0;
    // User navigates setup steps: pushState.
    env.setState(workflow, setup('packs'));
    expect(env.calls).toEqual([{ kind: 'push', url: '#/packs' }]);

    env.calls.length = 0;
    // Phone unlinks Signal while setup.step stays 'packs': automatic detour to #/signal must replaceState.
    env.setState(workflow, setup('packs', { signal: notLinked }));
    expect(env.calls).toEqual([{ kind: 'replace', url: '#/signal' }]);

    env.calls.length = 0;
    // Signal re-links: automatic return to #/packs must replaceState.
    env.setState(workflow, setup('packs', { signal: linked }));
    expect(env.calls).toEqual([{ kind: 'replace', url: '#/packs' }]);

    env.calls.length = 0;
    // User starts migration: pushState.
    env.setState(workflow, {
      ...session(),
      kind: 'migrating',
      run: { attempt: 1, status: 'running', friendsAdded: null, error: null },
    });
    expect(env.calls).toEqual([{ kind: 'push', url: '#/migrate' }]);

    env.calls.length = 0;
    // Migration auto-ends and finishes: no pushState.
    env.setState(workflow, { ...session(), kind: 'ending', reason: 'finish' });
    env.setState(workflow, { ...session(), kind: 'done' });
    expect(env.calls.filter((call) => call.kind === 'push')).toEqual([]);
  });

  it('ignores popstate while loading and honors reachable popstate after settling', () => {
    env.loc.hash = '#/review';
    const workflow = new Workflow(fakeServices);
    connectRouter(workflow);

    // Popstate during loading must not overwrite the hash with #/start.
    env.pop('#/review');
    expect(env.loc.hash).toBe('#/review');
    expect(env.calls).toEqual([]);

    env.setState(workflow, setup('review'));
    env.calls.length = 0;

    // Navigating back to reachable #/packs calls goTo without pushing.
    env.pop('#/packs');
    expect(workflow.step).toBe('packs');
    expect(env.calls).toEqual([]);

    // Navigating to unreachable #/migrate resets the hash via replaceState.
    env.pop('#/migrate');
    expect(workflow.step).toBe('packs');
    expect(env.calls).toEqual([{ kind: 'replace', url: '#/packs' }]);
  });
});
