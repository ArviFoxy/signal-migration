// Loads the WebAssembly module synchronously for tests running in Node.

import { readFileSync } from 'node:fs';
import { initSync } from '../src/wasm/signal_migration_wasm';

initSync({ module: readFileSync(new URL('../src/wasm/signal_migration_wasm_bg.wasm', import.meta.url)) });
