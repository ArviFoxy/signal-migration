// Browser harness for integration/tdlib-restart.test.ts: runs real TelegramClient + real tdweb (worker, WASM,
// BroadcastChannel, IndexedDB) so tests can inject a worker updateFatalError and verify Run 2 recovers instead of
// deadlocking on BroadcastChannel.

import { type LoginCopies, TelegramClient } from '../src/telegram/client';

const workers: Worker[] = [];
const NativeWorker = globalThis.Worker;
globalThis.Worker = class TrackedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    workers.push(this);
  }
};

type RestartReport = {
  run1State: string | null;
  run2State: string | null;
  runCount: number;
  fatalEvents: [string, boolean][];
  syncResults: string[];
  error?: string;
};

declare global {
  interface Window {
    runTdlibRestartTest: () => Promise<RestartReport>;
  }
}

window.runTdlibRestartTest = async () => {
  workers.length = 0;
  const instance = `telegram-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const states: { run: number; state: string }[] = [];
  const fatalEvents: [string, boolean][] = [];
  let client!: TelegramClient;

  // Pretend a login copy exists so TelegramClient restarts TDLib on fatal error even without real Telegram credentials.
  const fakeCopies: LoginCopies = {
    save: async () => undefined,
    restore: async () => true,
  };

  let waitRun1Resolve!: (state: string) => void;
  const run1Ready = new Promise<string>((resolve) => (waitRun1Resolve = resolve));
  let waitRun2Resolve!: (state: string) => void;
  const run2Ready = new Promise<string>((resolve) => (waitRun2Resolve = resolve));

  client = new TelegramClient(
    instance,
    { apiId: 12345, apiHash: '0123456789abcdef0123456789abcdef', testDc: true },
    (state) => {
      states.push({ run: client.run, state: state._ });
      if (client.run === 1 && state._ === 'authorizationStateWaitPhoneNumber') waitRun1Resolve(state._);
      if (client.run >= 2 && state._ === 'authorizationStateWaitPhoneNumber') waitRun2Resolve(state._);
    },
    (error, restarted) => fatalEvents.push([error, restarted]),
    fakeCopies,
  );

  const timeout = <T>(ms: number, label: string): Promise<T> =>
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms));

  let run1State: string | null = null;
  let run2State: string | null = null;
  const syncResults: string[] = [];

  try {
    run1State = await Promise.race([run1Ready, timeout<string>(15_000, 'run 1 startup')]);
    // Verify overlapping syncDatabase calls complete cleanly without corrupting IDBFS.
    const syncs = await Promise.all([
      client.checkpoint().then(
        () => 'ok',
        (err: unknown) => `err:${String(err)}`,
      ),
      client.checkpoint().then(
        () => 'ok',
        (err: unknown) => `err:${String(err)}`,
      ),
    ]);
    syncResults.push(...syncs);

    // Inject a worker-side fatal error on Run 1's real Worker to exercise TelegramClient.#onFatal -> Run 2.
    const worker1 = workers[0];
    if (!worker1) throw new Error('Run 1 worker was not created');
    worker1.onmessage?.(
      new MessageEvent('message', { data: { '@type': 'updateFatalError', error: 'simulated fatal' } }),
    );

    run2State = await Promise.race([run2Ready, timeout<string>(6_000, 'run 2 startup after fatal error')]);
    return { run1State, run2State, runCount: client.run, fatalEvents, syncResults };
  } catch (error) {
    return {
      run1State,
      run2State,
      runCount: client.run,
      fatalEvents,
      syncResults,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.dispose().catch(() => undefined);
  }
};
