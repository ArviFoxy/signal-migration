// Loads the libsignal/rustls WebAssembly module once, before any of its functions are used.
//
// Callers that access the module through `signalWasm()` cannot accidentally invoke a WebAssembly export before
// initialization completes, and a transient fetch failure clears the cached promise so "Try again" can recover.

import { buildVerifier } from '../attestation/runtime';
import { assetFile } from '../core/assets';
import { retryableOnce } from '../core/lazy';
import init, * as wasm from '../wasm/signal_migration_wasm';

const load = retryableOnce(async () => {
  const input = await buildVerifier.resolveWasmInput(assetFile('signalWasm'), import.meta.url);
  await init({ module_or_path: input });
  return wasm;
});

/** Initializes the Signal WebAssembly module if needed. */
export function loadSignalWasm(): Promise<void> {
  return load().then(() => undefined);
}

/** Initializes the Signal WebAssembly module if needed and returns its exports. */
export function signalWasm(): Promise<typeof wasm> {
  return load();
}
