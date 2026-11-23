// Runtime build-attestation verifier for the browser page.
//
// On page load (`start()`), fetches `./attestation.sigstore.json` and verifies the Sigstore bundle against the pinned
// trusted root and GitHub Actions policy, then hashes `index.html` and every script/stylesheet loaded by the document
// against the signed in-toto subject list.
//
// When a release is attested, lazy WebAssembly modules and workers are verified against the same signed subject list
// before instantiation (`verifyAndFetch` / `verifyAsset`), failing closed on any mismatch. When no attestation file
// exists (HTTP 404, such as local development), the build is reported as unverified and asset loads proceed normally.

import { assetUrl } from '../core/assets';
import { errorMessage } from '../core/errors';
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

/** Extracts the relative deployed path of a URL within `baseDir`, or null if outside `baseDir`. */
export function relativeAssetPath(url: string, baseDir: URL): string | null {
  let resolved: URL;
  try {
    resolved = new URL(url, baseDir);
  } catch {
    return null;
  }
  if (resolved.origin !== baseDir.origin) return null;
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
  #state: BuildVerification = { kind: 'checking' };
  #subjects: ReadonlyMap<string, string> | null = null;
  #verifiedAssets = new Set<string>();
  #startup: Promise<void> | null = null;
  #url: string = ATTESTATIONS_URL;

  constructor(
    private readonly policy: AttestationPolicy = DEFAULT_ATTESTATION_POLICY,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly verifyBundle: typeof verifyAttestationBundle = verifyAttestationBundle,
  ) {
    super();
  }

  get state(): BuildVerification {
    return this.#state;
  }

  #setState(next: BuildVerification): void {
    this.#state = next;
    this.dispatchEvent(new Event('change'));
  }

  #fail(reason: string): void {
    this.#subjects = null;
    this.#verifiedAssets.clear();
    this.#setState({ kind: 'failed', reason, url: this.#url });
  }

  /** Starts startup verification once and returns its completion promise. */
  start(doc: Document = document, pageHref: string = location.href): Promise<void> {
    if (!this.#startup) this.#startup = this.#runStartup(doc, pageHref);
    return this.#startup;
  }

  async #runStartup(doc: Document, pageHref: string): Promise<void> {
    const baseDir = new URL('./', pageHref);
    try {
      const bundleResponse = await this.fetchImpl(new URL(BUNDLE_PATH, baseDir).href, { cache: 'no-cache' });
      if (bundleResponse.status === 404) {
        this.#setState({ kind: 'unverified', url: ATTESTATIONS_URL });
        return;
      }
      if (!bundleResponse.ok) {
        this.#fail(`fetching ${BUNDLE_PATH} answered ${bundleResponse.status}`);
        return;
      }

      const [bundle, meta] = await Promise.all([
        bundleResponse.json() as Promise<unknown>,
        this.fetchImpl(new URL(META_PATH, baseDir).href, { cache: 'no-cache' })
          .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
          .catch(() => null),
      ]);
      this.#url = parseAttestationUrl(meta, ATTESTATIONS_URL);

      const verified = await this.verifyBundle(bundle, this.policy);

      const { paths, external } = documentEntryAssets(doc, baseDir);
      if (external.length > 0) {
        throw new Error(`document references unattested external asset: ${external[0]}`);
      }
      if (!paths.some((path) => path.endsWith('.js'))) {
        throw new Error('document has no script entry to verify');
      }

      await Promise.all(
        paths.map(async (relPath) => {
          const response = await this.fetchImpl(new URL(relPath, baseDir).href);
          if (!response.ok) throw new Error(`fetching '${relPath}' answered ${response.status}`);
          await verifyFileDigest(relPath, await response.arrayBuffer(), verified.subjects);
          this.#verifiedAssets.add(relPath);
        }),
      );

      this.#subjects = verified.subjects;
      this.#setState({ kind: 'verified', tag: verified.tag, commit: verified.commit, url: this.#url });
    } catch (error) {
      this.#fail(errorMessage(error));
    }
  }

  /**
   * Fetches `file` (relative to the app's assets) and, when the build is attested, verifies its SHA-256 against the
   * signed provenance statement before returning its bytes. Fails closed if verification already failed or disagrees.
   */
  async verifyAndFetch(file: string, baseUrl: string = import.meta.url): Promise<ArrayBuffer> {
    if (this.#startup) await this.#startup;
    if (this.#state.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#state.reason}`);
    }
    const response = await this.fetchImpl(assetUrl(file, baseUrl));
    if (!response.ok) throw new Error(`fetching '${file}' answered ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (this.#subjects !== null) {
      try {
        await verifyFileDigest(file, bytes, this.#subjects);
        this.#verifiedAssets.add(file);
      } catch (error) {
        const reason = errorMessage(error);
        this.#fail(reason);
        throw new Error(`Refusing to load '${file}': ${reason}`);
      }
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
    if (this.#state.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#state.reason}`);
    }
    if (this.#subjects !== null) {
      return this.verifyAndFetch(file, baseUrl);
    }
    return new URL(assetUrl(file, baseUrl));
  }

  /**
   * Checks `file` against the signed provenance statement (at most once per filename) when the build is attested.
   * No-op when `start()` was never called or no attestation exists (local development).
   */
  async verifyAsset(file: string, baseUrl: string = import.meta.url): Promise<void> {
    if (!this.#startup) return;
    await this.#startup;
    if (this.#state.kind === 'failed') {
      throw new Error(`Refusing to load '${file}': ${this.#state.reason}`);
    }
    if (this.#subjects === null || this.#verifiedAssets.has(file)) return;
    await this.verifyAndFetch(file, baseUrl);
  }
}

export const buildVerifier = new BuildVerifier();
