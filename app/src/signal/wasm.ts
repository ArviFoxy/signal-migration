// Loads the libsignal/rustls WebAssembly module once, before any of its functions are used.

import init from '../wasm/signal_migration_wasm';

let loading: Promise<void> | null = null;

export function loadSignalWasm(): Promise<void> {
  loading ??= init({ module_or_path: '/signal_migration_wasm_bg.wasm' }).then(() => undefined);
  return loading;
}
