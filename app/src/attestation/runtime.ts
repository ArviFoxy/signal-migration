// Runtime build-attestation verifier for the browser page.
//
// On page load (`start()`), fetches `./attestation.sigstore.json` and verifies the Sigstore bundle against the pinned
// trusted root and GitHub Actions policy, then hashes `index.html` and every script/stylesheet loaded by the document
// against the signed in-toto subject list.
//
// When a release is attested, lazy WebAssembly modules and workers are verified against the same signed subject list
// before instantiation (`verifyAndFetch` / `resolveWasmInput` / `resolveWorkerInput` / `verifyAsset`), failing closed
// on any mismatch. When no attestation file exists (HTTP 404, such as local development), the build is reported as
// unverified and asset loads proceed normally.

import { assetUrl } from '../core/assets';
import { errorMessage } from '../core/errors';
import { SERVER_TIME_LIMIT_S, withFetchTimeLimit } from '../core/time-limit';
import { ATTESTATIONS_URL } from './config';
import {
  type AttestationPolicy,
  type BuildVerification,
  DEFAULT_ATTESTATION_POLICY,
  parseAttestationUrl,
  verifyAttestationBundle,
  verifyFileDigest,
} from './verify';

const BUNDLE_PATH = 'attestation.sigstore.json';
const META_PATH = 'attestation-meta.json';

type Phase =
  | { kind: 'checking' }
  | { kind: 'unverified' }
  | { kind: 'verified'; subjects: ReadonlyMap<string, string>; tag: string; commit: string }
  | { kind: 'failed'; reason: string };

/** Extracts the relative deployed path of a URL within `baseDir`, or null if outside `baseDir` or carrying a query. */
export function relativeAssetPath(url: string, baseDir: URL): string | null {
  let resolved: URL;
  try {
    resolved = new URL(url, baseDir);
  } catch {
    return null;
  }
  if (resolved.origin !== baseDir.origin) return null;
  if (resolved.search !== '') return null;
  if (!resolved.pathname.startsWith(baseDir.pathname)) return null;
  const rel = resolved.pathname.slice(baseDir.pathname.length);
  return rel.length > 0 && !rel.startsWith('/') ? rel : null;
}

/** Collects the deployed relative paths of every script and stylesheet element currently in `doc`. */
export function documentEntryAssets(doc: Document, baseDir: URL): { paths: string[]; external: string[] } {
  const paths = new Set<string>(['index.html']);
  const external: string[] = [];
  for (const element of doc.querySelectorAll('script[src], link[rel="stylesheet"][href]')) {
    const raw = element.getAttribute(element.tagName === 'SCRIPT' ? 'src' : 'href');
    if (!raw) continue;
    const rel = relativeAssetPath(raw, baseDir);
    if (rel === null) external.push(raw);
    else paths.add(rel);
  }
  return { paths: [...paths], external };
}

export class BuildVerifier extends EventTarget {
  #phase: Phase = { kind: 'checking' };
  #startup: Promise<void> | null = null;
  #url: string = ATTESTATIONS_URL;

  constructor(
    private readonly policy: AttestationPolicy = DEFAULT_ATTESTATION_POLICY,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly verifyBundle: typeof verifyAttestationBundle = verifyAttestationBundle,
    private readonly timeLimitS: number = SERVER_TIME_LIMIT_S,
  ) {
    super();
  }

  get state(): BuildVerification {
    switch (this.#phase.kind) {
      case 'checking':
        return { kind: 'checking' };
      case 'unverified':
        return { kind: 'unverified', url: ATTESTATIONS_URL };
      case 'verified':
        return { kind: 'verified', tag: this.#phase.tag, commit: this.#phase.commit, url: this.#url };
      case 'failed':
        return { kind: 'failed', reason: this.#phase.reason, url: this.#url };
    }
  }

  #setPhase(next: Phase): void {
    this.#phase = next;
    this.dispatchEvent(new Event('change'));
  }

  #fail(reason: string): void {
    this.#setPhase({ kind: 'failed', reason });
  }

  #fetchBounded<T>(url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    return withFetchTimeLimit('The migration server', this.timeLimitS, url, init, consume, this.fetchImpl);
  }

  /** Fetches the optional attestation link ID in the background so a slow metadata request never blocks startup. */
  #loadMetaUrl(baseDir: URL): void {
    void this.#fetchBounded(new URL(META_PATH, baseDir).href, { cache: 'no-cache' }, async (response) =>
      response.ok ? ((await response.json()) as unknown) : null,
    )
      .then((meta) => {
        const nextUrl = parseAttestationUrl(meta, ATTESTATIONS_URL);
        if (nextUrl !== this.#url) {
          this.#url = nextUrl;
          this.dispatchEvent(new Event('change'));
        }
      })
      .catch(() => undefined);
  }

  /** Starts startup verification once and returns its completion promise. */
  start(doc: Document = document, pageHref: string = location.href): Promise<void> {
    if (!this.#startup) this.#startup = this.#runStartup(doc, pageHref);
    return this.#startup;
  }

  async #runStartup(doc: Document, pageHref: string): Promise<void> {
    const baseDir = new URL('./', pageHref);
    try {
      const bundle = await this.#fetchBounded(
        new URL(BUNDLE_PATH, baseDir).href,
        { cache: 'no-cache' },
        async (response) => {
          if (response.status === 404) return null;
          if (!response.ok) throw new Error(`fetching ${BUNDLE_PATH} answered ${response.status}`);
          return (await response.json()) as unknown;
        },
      );
      if (bundle === null) {
        this.#setPhase({ kind: 'unverified' });
        return;
      }

      this.#loadMetaUrl(baseDir);

      const verified = await this.verifyBundle(bundle, this.policy);

      const { paths, external } = documentEntryAssets(doc, baseDir);
      if (external.length > 0) {
        throw new Error(`document references unattested external asset: ${external[0]}`);
      }
      if (!paths.some((path) => path.endsWith('.js'))) {
        throw new Error('document has no script entry to verify');
      }

      await Promise.all(
        paths.map((relPath) =>
          this.#fetchBounded(new URL(relPath, baseDir).href, {}, async (response) => {
            if (!response.ok) throw new Error(`fetching '${relPath}' answered ${response.status}`);
            await verifyFileDigest(relPath, await response.arrayBuffer(), verified.subjects);
          }),
        ),
      );

      this.#setPhase({ kind: 'verified', subjects: verified.subjects, tag: verified.tag, commit: verified.commit });
    } catch (error) {
      this.#fail(errorMessage(error));
    }
  }

  #throwIfFailed(file: string): void {
    if (this.#phase.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#phase.reason}`);
    }
  }

  /**
   * Fetches `file` (relative to the app's assets) and, when the build is attested, verifies its SHA-256 against the
   * signed provenance statement before returning its bytes. Fails closed if verification already failed or disagrees,
   * even across concurrent calls.
   */
  async verifyAndFetch(file: string, baseUrl: string = import.meta.url): Promise<ArrayBuffer> {
    if (this.#startup) await this.#startup;
    const phase = this.#phase;
    this.#throwIfFailed(file);
    const bytes = await this.#fetchBounded(assetUrl(file, baseUrl), {}, async (response) => {
      if (!response.ok) throw new Error(`fetching '${file}' answered ${response.status}`);
      return response.arrayBuffer();
    });
    this.#throwIfFailed(file);
    if (phase.kind === 'verified') {
      try {
        await verifyFileDigest(file, bytes, phase.subjects);
      } catch (error) {
        const reason = errorMessage(error);
        this.#fail(reason);
        throw new Error(`Refusing to load '${file}': ${reason}`);
      }
      this.#throwIfFailed(file);
    }
    return bytes;
  }

  /**
   * Returns a verified `ArrayBuffer` for a WebAssembly module when running an attested build, or its resolved URL when
   * running an unattested build (allowing streaming compilation in dev and `initSync` short-circuiting in unit tests).
   * Fails closed if verification already failed or the fetched bytes disagree with the signed attestation.
   */
  async resolveWasmInput(file: string, baseUrl: string = import.meta.url): Promise<ArrayBuffer | URL> {
    if (!this.#startup) return new URL(assetUrl(file, baseUrl));
    await this.#startup;
    if (this.#phase.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#phase.reason}`);
    }
    if (this.#phase.kind === 'verified') {
      return this.verifyAndFetch(file, baseUrl);
    }
    return new URL(assetUrl(file, baseUrl));
  }

  /**
   * Returns a verified `Blob` URL for a self-contained worker bundle when running an attested build (avoiding a second
   * unverified network fetch), or the asset URL when running unattested. Callers invoke `revoke()` when terminating.
   */
  async resolveWorkerInput(
    file: string,
    baseUrl: string = import.meta.url,
  ): Promise<{ url: string; revoke: () => void }> {
    if (!this.#startup) return { url: assetUrl(file, baseUrl), revoke: () => undefined };
    await this.#startup;
    if (this.#phase.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#phase.reason}`);
    }
    if (this.#phase.kind === 'verified') {
      const bytes = await this.verifyAndFetch(file, baseUrl);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      return { url, revoke: () => URL.revokeObjectURL(url) };
    }
    return { url: assetUrl(file, baseUrl), revoke: () => undefined };
  }

  /**
   * Checks `file` against the signed provenance statement when the build is attested. Re-verifies on every call so
   * worker or TDLib restarts do not rely on a stale check. No-op when `start()` was never called or unattested.
   */
  async verifyAsset(file: string, baseUrl: string = import.meta.url): Promise<void> {
    if (!this.#startup) return;
    await this.#startup;
    if (this.#phase.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#phase.reason}`);
    }
    if (this.#phase.kind !== 'verified') return;
    await this.verifyAndFetch(file, baseUrl);
  }
}

export const buildVerifier = new BuildVerifier();
