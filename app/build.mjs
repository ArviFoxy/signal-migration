// Builds the web app into dist/: bundles each entry point and copies the static files and the WebAssembly module.
import { build } from 'esbuild';
import fs from 'node:fs';

const entries = ['src/main.ts', 'src/diagnostics.ts'].filter((file) => fs.existsSync(file));

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });
await build({ entryPoints: entries, bundle: true, format: 'esm', target: 'es2022', outdir: 'dist', sourcemap: true });
fs.cpSync('public', 'dist', { recursive: true });
fs.copyFileSync('src/wasm/signal_migration_wasm_bg.wasm', 'dist/signal_migration_wasm_bg.wasm');
