// The tests run with Vitest's defaults; only the WebM decoder module, which scripts/build-webm-decoder.sh builds
// outside the app, needs its location.
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { 'webm-decoder': path.resolve(__dirname, '../build/webm-decoder/webm-decoder.js') } },
});
