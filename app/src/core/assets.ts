// Resolves built static asset filenames and URLs relative to the running script.
//
// `build.mjs` content-hashes the built JS, CSS and WebAssembly filenames (so GitHub Pages' 10-minute cache never mixes
// files across releases) and injects the exact filenames at build time via `__ASSET_FILES__` and `__TDLIB_FILES__`.
// Builds that bypass `build.mjs` (unit tests, picture integration tests, measurement harnesses) fall back to the
// unhashed names. Resolving through `import.meta.url` works identically at `/` and under a subpath like `/repo/`.

export const DEFAULT_ASSETS = {
  signalWasm: 'signal_migration_wasm_bg.wasm',
  attestationWasm: 'attestation_wasm_bg.wasm',
  webmDecoderWasm: 'webm-decoder.wasm',
  apngWorker: 'apng-worker.js',
  webmWorker: 'webm-worker.js',
} as const;

export type AssetKey = keyof typeof DEFAULT_ASSETS;

declare const __ASSET_FILES__: Partial<Record<AssetKey, string>> | undefined;
declare const __TDLIB_FILES__: readonly string[] | undefined;

/** The deployed filename for a built asset (content-hashed when built via `build.mjs`). */
export function assetFile(key: AssetKey): string {
  const configured = typeof __ASSET_FILES__ !== 'undefined' ? __ASSET_FILES__?.[key] : undefined;
  return configured ?? DEFAULT_ASSETS[key];
}

/** Resolves a deployed asset filename relative to `baseUrl` (defaulting to the current module's URL). */
export function assetUrl(file: string, baseUrl: string = import.meta.url): string {
  return new URL(`./${file}`, baseUrl).href;
}

/** The TDLib sidecar filenames (`*.worker.js`, `*.wasm`) copied beside the app by `build.mjs`. */
export function tdlibFiles(): readonly string[] {
  return typeof __TDLIB_FILES__ !== 'undefined' && Array.isArray(__TDLIB_FILES__) ? __TDLIB_FILES__ : [];
}
