import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SigstoreBundle, TrustedRoot } from '@freedomofpress/sigstore-browser';
import { ATTESTATIONS_URL } from '../src/attestation/config';
import { BuildVerifier, relativeAssetPath } from '../src/attestation/runtime';
import pinnedTrustedRoot from '../src/attestation/trusted-root.json';
import {
  type AttestationPolicy,
  DEFAULT_ATTESTATION_POLICY,
  parseAttestationUrl,
  sha256Hex,
  verifyAttestationBundle,
  verifyFileDigest,
} from '../src/attestation/verify';

const realCliBundle = JSON.parse(
  readFileSync(new URL('./fixtures/cli-slsa-attestation.sigstore.json', import.meta.url), 'utf8'),
) as SigstoreBundle;

const cliPolicy: AttestationPolicy = {
  repository: 'cli/cli',
  workflowPath: '.github/workflows/deployment.yml',
  trigger: 'workflow_dispatch',
  refPattern: /^refs\/heads\/(trunk)$/,
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const bytesOf = (text: string) => new TextEncoder().encode(text);

function fakeDocument(scripts: string[], styles: string[]): Document {
  const elements = [
    ...scripts.map((src) => ({ tagName: 'SCRIPT', getAttribute: (name: string) => (name === 'src' ? src : null) })),
    ...styles.map((href) => ({ tagName: 'LINK', getAttribute: (name: string) => (name === 'href' ? href : null) })),
  ];
  return { querySelectorAll: () => elements } as unknown as Document;
}

function fakeFetch(files: Record<string, { status?: number; body?: string | Uint8Array }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const entry = files[url];
    if (!entry) return new Response('not found', { status: 404 });
    const status = entry.status ?? 200;
    const raw = entry.body ?? '';
    const bytes = typeof raw === 'string' ? bytesOf(raw) : raw;
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status });
  }) as typeof fetch;
}

describe('Sigstore build attestation verification', () => {
  // Detects: regressions in Fulcio X.509 chain, CT SCT, Rekor inclusion proof, DSSE signature, or SLSA v1.0 parsing
  // against a real GitHub Artifact Attestation bundle.
  it('verifies a real GitHub Actions SLSA provenance bundle against the pinned Sigstore root', async () => {
    const verified = await verifyAttestationBundle(realCliBundle, cliPolicy);
    expect(verified.tag).toBe('trunk');
    expect(verified.ref).toBe('refs/heads/trunk');
    expect(verified.commit).toBe('e1219499a578b69e3437adaa31cd60614e23c802');
    expect(verified.subjects.get('gh_2.105.0_linux_386.deb')).toBe(
      '4835dbdbdcf8ba8bcb69515da797375d2eb955f824ebe686df8df07876a69fe8',
    );
  });

  // Detects: an attacker replaying a valid GitHub Actions attestation from another repository, workflow, trigger, or ref.
  it('rejects a real attestation that violates repository, workflow, trigger, or tag policy', async () => {
    await expect(verifyAttestationBundle(realCliBundle, DEFAULT_ATTESTATION_POLICY)).rejects.toThrow();
    await expect(
      verifyAttestationBundle(realCliBundle, { ...cliPolicy, workflowPath: '.github/workflows/release.yml' }),
    ).rejects.toThrow();
    await expect(verifyAttestationBundle(realCliBundle, { ...cliPolicy, trigger: 'release' })).rejects.toThrow();
    await expect(
      verifyAttestationBundle(realCliBundle, { ...cliPolicy, refPattern: /^refs\/tags\/(v[^\s/]+)$/ }),
    ).rejects.toThrow();
  });

  // Detects: tampering with the DSSE payload, DSSE signature, Rekor inclusion proof, or trusted root CA.
  it('rejects tampered payloads, signatures, transparency proofs, and untrusted roots', async () => {
    const tamperedPayload = clone(realCliBundle);
    const decoded = Buffer.from(tamperedPayload.dsseEnvelope!.payload, 'base64').toString('utf8');
    tamperedPayload.dsseEnvelope!.payload = Buffer.from(decoded.replace('gh_2.105.0', 'gh_9.999.9')).toString('base64');
    await expect(verifyAttestationBundle(tamperedPayload, cliPolicy)).rejects.toThrow();

    const tamperedSig = clone(realCliBundle);
    const sigBytes = Buffer.from(tamperedSig.dsseEnvelope!.signatures[0].sig, 'base64');
    sigBytes[0] ^= 0xff;
    tamperedSig.dsseEnvelope!.signatures[0].sig = sigBytes.toString('base64');
    await expect(verifyAttestationBundle(tamperedSig, cliPolicy)).rejects.toThrow();

    const tamperedProof = clone(realCliBundle);
    const hashes = tamperedProof.verificationMaterial.tlogEntries[0].inclusionProof!.hashes;
    const hashBytes = Buffer.from(hashes[0], 'base64');
    hashBytes[0] ^= 0x01;
    hashes[0] = hashBytes.toString('base64');
    await expect(verifyAttestationBundle(tamperedProof, cliPolicy)).rejects.toThrow();

    const emptyRoot = clone(pinnedTrustedRoot) as unknown as TrustedRoot;
    emptyRoot.certificateAuthorities = [];
    await expect(verifyAttestationBundle(realCliBundle, cliPolicy, emptyRoot)).rejects.toThrow();
  });

  // Detects: invalid or malicious attestationId metadata being used to construct arbitrary redirect URLs.
  it('validates attestationId strictly when building the GitHub attestation link', () => {
    expect(parseAttestationUrl({ attestationId: '987654321' }, ATTESTATIONS_URL)).toBe(`${ATTESTATIONS_URL}/987654321`);
    expect(parseAttestationUrl({ attestationId: '../evil' }, ATTESTATIONS_URL)).toBe(ATTESTATIONS_URL);
    expect(parseAttestationUrl({ attestationId: '123/extra' }, ATTESTATIONS_URL)).toBe(ATTESTATIONS_URL);
    expect(parseAttestationUrl({ attestationId: '' }, ATTESTATIONS_URL)).toBe(ATTESTATIONS_URL);
    expect(parseAttestationUrl(null, ATTESTATIONS_URL)).toBe(ATTESTATIONS_URL);
  });

  // Detects: file digest mismatches or unlisted files silently passing verification.
  it('verifies file SHA-256 digests against the signed subject map', async () => {
    const content = bytesOf('hello signal-migration');
    const digest = await sha256Hex(content);
    const subjects = new Map([['main-12345678.js', digest]]);
    await expect(verifyFileDigest('main-12345678.js', content, subjects)).resolves.toBeUndefined();
    await expect(verifyFileDigest('main-12345678.js', bytesOf('tampered'), subjects)).rejects.toThrow(/SHA-256/);
    await expect(verifyFileDigest('other.js', content, subjects)).rejects.toThrow(/not listed/);
  });

  it('resolves relative asset paths within both root and subpath deployments', () => {
    const subpath = new URL('https://arvifoxy.github.io/signal-migration/');
    expect(relativeAssetPath('./main-abc.js', subpath)).toBe('main-abc.js');
    expect(relativeAssetPath('./fonts/inter.woff2', subpath)).toBe('fonts/inter.woff2');
    expect(relativeAssetPath('./main-abc.js?v=evil', subpath)).toBeNull();
    expect(relativeAssetPath('https://arvifoxy.github.io/other/main.js', subpath)).toBeNull();
    expect(relativeAssetPath('https://evil.example/main.js', subpath)).toBeNull();
  });
});

describe('BuildVerifier runtime', () => {
  const base = 'https://arvifoxy.github.io/signal-migration/';

  // Detects: local/dev unattested builds failing instead of reporting unverified and allowing asset loads.
  it('marks 404 attestation as unverified and allows unattested WebAssembly loads', async () => {
    const verifier = new BuildVerifier(DEFAULT_ATTESTATION_POLICY, fakeFetch({}));
    await verifier.start(fakeDocument(['./main.js'], ['./styles.css']), `${base}index.html`);
    expect(verifier.state).toEqual({ kind: 'unverified', url: ATTESTATIONS_URL });

    const input = await verifier.resolveWasmInput('signal_migration_wasm_bg.wasm', `${base}main.js`);
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).href).toBe(`${base}signal_migration_wasm_bg.wasm`);
  });

  // Detects: entry asset verification, lazy WASM verification, and fail-closed behavior on tampered lazy assets.
  it('verifies entry assets and lazy WASM modules, failing closed if a lazy asset is tampered', async () => {
    const htmlBytes = bytesOf('<html></html>');
    const jsBytes = bytesOf('console.log("ok")');
    const cssBytes = bytesOf('body{}');
    const goodWasm = bytesOf('good-wasm-bytes');
    const badWasm = bytesOf('tampered-wasm-bytes');

    const subjects = new Map([
      ['index.html', await sha256Hex(htmlBytes)],
      ['main-11111111.js', await sha256Hex(jsBytes)],
      ['styles-22222222.css', await sha256Hex(cssBytes)],
      ['signal_migration_wasm_bg-33333333.wasm', await sha256Hex(goodWasm)],
      ['attestation_wasm_bg-44444444.wasm', await sha256Hex(goodWasm)],
    ]);

    const verifier = new BuildVerifier(
      DEFAULT_ATTESTATION_POLICY,
      fakeFetch({
        [`${base}attestation.sigstore.json`]: { body: '{}' },
        [`${base}attestation-meta.json`]: { body: '{"attestationId":"4242"}' },
        [`${base}index.html`]: { body: htmlBytes },
        [`${base}main-11111111.js`]: { body: jsBytes },
        [`${base}styles-22222222.css`]: { body: cssBytes },
        [`${base}signal_migration_wasm_bg-33333333.wasm`]: { body: goodWasm },
        [`${base}attestation_wasm_bg-44444444.wasm`]: { body: badWasm },
      }),
      async () => ({
        tag: 'v0.1.0',
        ref: 'refs/tags/v0.1.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        subjects,
      }),
    );

    await verifier.start(fakeDocument(['./main-11111111.js'], ['./styles-22222222.css']), base);
    expect(verifier.state).toEqual({
      kind: 'verified',
      tag: 'v0.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      url: `${ATTESTATIONS_URL}/4242`,
    });

    // Matching lazy WASM returns verified ArrayBuffer bytes.
    const resolved = await verifier.resolveWasmInput(
      'signal_migration_wasm_bg-33333333.wasm',
      `${base}main-11111111.js`,
    );
    expect(resolved).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(resolved as ArrayBuffer)).toEqual(goodWasm);

    // Tampered lazy WASM fails closed and flips build verification state to failed.
    await expect(
      verifier.resolveWasmInput('attestation_wasm_bg-44444444.wasm', `${base}main-11111111.js`),
    ).rejects.toThrow(/SHA-256/);
    expect(verifier.state.kind).toBe('failed');

    // Subsequent loads fail closed too.
    await expect(
      verifier.resolveWasmInput('signal_migration_wasm_bg-33333333.wasm', `${base}main-11111111.js`),
    ).rejects.toThrow(/Refusing to load/);
  });

  // Detects: an external script injected into the page bypassing entry asset verification.
  it('fails if the document loads a script outside the deployed directory', async () => {
    const htmlBytes = bytesOf('<html></html>');
    const jsBytes = bytesOf('console.log("ok")');
    const subjects = new Map([
      ['index.html', await sha256Hex(htmlBytes)],
      ['main-11111111.js', await sha256Hex(jsBytes)],
    ]);
    const verifier = new BuildVerifier(
      DEFAULT_ATTESTATION_POLICY,
      fakeFetch({
        [`${base}attestation.sigstore.json`]: { body: '{}' },
        [`${base}index.html`]: { body: htmlBytes },
        [`${base}main-11111111.js`]: { body: jsBytes },
      }),
      async () => ({
        tag: 'v0.1.0',
        ref: 'refs/tags/v0.1.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        subjects,
      }),
    );

    await verifier.start(fakeDocument(['./main-11111111.js', 'https://evil.example/inject.js'], []), base);
    expect(verifier.state.kind).toBe('failed');
  });

  // Detects: concurrent verifyAndFetch failing closed when a sibling call detects a tampered asset and clears #subjects.
  it('fails closed on concurrent verifyAndFetch when another concurrent verification fails', async () => {
    const htmlBytes = bytesOf('<html></html>');
    const jsBytes = bytesOf('console.log("ok")');
    const goodWasm = bytesOf('good-wasm');
    const badWasm = bytesOf('tampered-wasm');
    const subjects = new Map([
      ['index.html', await sha256Hex(htmlBytes)],
      ['main-11111111.js', await sha256Hex(jsBytes)],
      ['a.wasm', await sha256Hex(goodWasm)],
      ['b.wasm', await sha256Hex(goodWasm)],
    ]);

    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    const baseFetch = fakeFetch({
      [`${base}attestation.sigstore.json`]: { body: '{}' },
      [`${base}index.html`]: { body: htmlBytes },
      [`${base}main-11111111.js`]: { body: jsBytes },
      [`${base}a.wasm`]: { body: badWasm },
      [`${base}b.wasm`]: { body: badWasm },
    });
    const gatedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('b.wasm')) await gateB;
      return baseFetch(input, init);
    }) as typeof fetch;

    const verifier = new BuildVerifier(DEFAULT_ATTESTATION_POLICY, gatedFetch, async () => ({
      tag: 'v0.1.0',
      ref: 'refs/tags/v0.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      subjects,
    }));
    await verifier.start(fakeDocument(['./main-11111111.js'], []), base);
    expect(verifier.state.kind).toBe('verified');

    const first = verifier.verifyAndFetch('a.wasm', `${base}main-11111111.js`);
    const second = verifier.verifyAndFetch('b.wasm', `${base}main-11111111.js`);
    await expect(first).rejects.toThrow(/SHA-256/);
    expect(verifier.state.kind).toBe('failed');

    releaseB();
    await expect(second).rejects.toThrow(/Refusing to load|SHA-256/);
  });

  // Detects: a stalled optional attestation-meta.json blocking startup verification and every lazy WASM load forever.
  it('does not block startup verification if optional attestation-meta.json hangs', async () => {
    const htmlBytes = bytesOf('<html></html>');
    const jsBytes = bytesOf('console.log("ok")');
    const subjects = new Map([
      ['index.html', await sha256Hex(htmlBytes)],
      ['main-11111111.js', await sha256Hex(jsBytes)],
    ]);
    const baseFetch = fakeFetch({
      [`${base}attestation.sigstore.json`]: { body: '{}' },
      [`${base}index.html`]: { body: htmlBytes },
      [`${base}main-11111111.js`]: { body: jsBytes },
    });
    const hangingMetaFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('attestation-meta.json')) return new Promise<Response>(() => undefined);
      return baseFetch(input, init);
    }) as typeof fetch;

    const verifier = new BuildVerifier(DEFAULT_ATTESTATION_POLICY, hangingMetaFetch, async () => ({
      tag: 'v0.1.0',
      ref: 'refs/tags/v0.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      subjects,
    }));
    const outcome = await Promise.race([
      verifier.start(fakeDocument(['./main-11111111.js'], []), base).then(() => 'started'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 200)),
    ]);
    expect(outcome).toBe('started');
    expect(verifier.state.kind).toBe('verified');
  });

  // Detects: verifyAsset skipping re-verification on subsequent calls (e.g., after a worker or TDLib crash restart).
  it('re-verifies assets on subsequent verifyAsset calls rather than caching forever', async () => {
    const htmlBytes = bytesOf('<html></html>');
    const jsBytes = bytesOf('console.log("ok")');
    const goodWorker = bytesOf('good-worker');
    const badWorker = bytesOf('tampered-worker');
    const subjects = new Map([
      ['index.html', await sha256Hex(htmlBytes)],
      ['main-11111111.js', await sha256Hex(jsBytes)],
      ['tdweb.worker.js', await sha256Hex(goodWorker)],
    ]);
    let workerFetches = 0;
    const baseFetch = fakeFetch({
      [`${base}attestation.sigstore.json`]: { body: '{}' },
      [`${base}index.html`]: { body: htmlBytes },
      [`${base}main-11111111.js`]: { body: jsBytes },
    });
    const rotatingFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('tdweb.worker.js')) {
        workerFetches++;
        const body = workerFetches === 1 ? goodWorker : badWorker;
        return new Response(body as Uint8Array<ArrayBuffer>, { status: 200 });
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    const verifier = new BuildVerifier(DEFAULT_ATTESTATION_POLICY, rotatingFetch, async () => ({
      tag: 'v0.1.0',
      ref: 'refs/tags/v0.1.0',
      commit: '0123456789abcdef0123456789abcdef01234567',
      subjects,
    }));
    await verifier.start(fakeDocument(['./main-11111111.js'], []), base);
    await expect(verifier.verifyAsset('tdweb.worker.js', `${base}main-11111111.js`)).resolves.toBeUndefined();
    await expect(verifier.verifyAsset('tdweb.worker.js', `${base}main-11111111.js`)).rejects.toThrow(/SHA-256/);
    expect(verifier.state.kind).toBe('failed');
  });

  // Detects: resolveWorkerInput issuing an unverified second fetch instead of creating a Blob URL from verified bytes.
  it('returns a verified Blob URL from resolveWorkerInput when attested', async () => {
    const htmlBytes = bytesOf('<html></html>');
    const jsBytes = bytesOf('console.log("ok")');
    const workerBytes = bytesOf('self.onmessage = () => {};');
    const subjects = new Map([
      ['index.html', await sha256Hex(htmlBytes)],
      ['main-11111111.js', await sha256Hex(jsBytes)],
      ['apng-worker.js', await sha256Hex(workerBytes)],
    ]);
    const verifier = new BuildVerifier(
      DEFAULT_ATTESTATION_POLICY,
      fakeFetch({
        [`${base}attestation.sigstore.json`]: { body: '{}' },
        [`${base}index.html`]: { body: htmlBytes },
        [`${base}main-11111111.js`]: { body: jsBytes },
        [`${base}apng-worker.js`]: { body: workerBytes },
      }),
      async () => ({
        tag: 'v0.1.0',
        ref: 'refs/tags/v0.1.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        subjects,
      }),
    );
    await verifier.start(fakeDocument(['./main-11111111.js'], []), base);
    const worker = await verifier.resolveWorkerInput('apng-worker.js', `${base}main-11111111.js`);
    expect(worker.url.startsWith('blob:')).toBe(true);
    worker.revoke();
  });
});
