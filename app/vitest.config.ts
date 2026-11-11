// The tests run with Vitest's defaults, apart from where two modules are found that are built outside the app:
// TDLib's web client (scripts/build-tdweb-js.sh) and the WebM decoder (scripts/build-webm-decoder.sh). The "tdweb"
// package in node_modules holds no built file, so the name points at the built one, as it does in app/build.mjs.
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      tdweb: path.resolve(__dirname, '../build/tdweb/dist/tdweb.js'),
      'webm-decoder': path.resolve(__dirname, '../build/webm-decoder/webm-decoder.js'),
    },
  },
  // The integration tests have their own configuration (vitest.integration.config.ts).
  test: { exclude: [...configDefaults.exclude, 'integration/**'] },
});
