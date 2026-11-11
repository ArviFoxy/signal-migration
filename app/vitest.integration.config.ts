// The integration tests (integration/): the real server and the built app in a real Chrome. They need the built app
// (`npm run build`), a Rust toolchain and Chrome, so they have their own command, `npm run test:integration`, and
// are not part of `npm test`. They share one server and one browser, so the test files run one after another.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['integration/**/*.test.ts'], fileParallelism: false, testTimeout: 60_000 },
});
