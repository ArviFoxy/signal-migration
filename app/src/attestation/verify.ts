// Cryptographic verification of GitHub Artifact Attestations (SLSA v1.0 build provenance in a Sigstore bundle).
//
// Uses `@freedomofpress/sigstore-browser` with the repository's pinned Sigstore Public Good `trusted-root.json`:
//   1. Verifies the Fulcio X.509 certificate chain to the pinned Fulcio root CA and embedded CT log SCTs.
//   2. Verifies the Rekor transparency log Merkle inclusion proof, checkpoint signature, and signing-time validity.
//   3. Enforces a strict Fulcio OIDC X.509 extension policy (GitHub Actions issuer, repository, github-hosted runner,
//      trigger, tag ref, and exact workflow URI).
//   4. Verifies the DSSE signature over the in-toto SLSA v1.0 provenance statement and cross-checks its workflow
//      claims against the certificate.
//   5. Extracts the signed map of deployed file paths to SHA-256 digests so callers can check served files against it.

import {
  AllOf,
  GITHUB_OIDC_ISSUER,
  OIDCBuildTrigger,
  OIDCIssuerV2,
  OIDCRunnerEnvironment,
  OIDCSourceRepositoryURI,
  PolicyError,
  type SigstoreBundle,
  SigstoreVerifier,
  type TrustedRoot,
  type VerificationPolicy,
  type X509Certificate,
} from '@freedomofpress/sigstore-browser';
import { toHex } from '../core/bytes';
import { ATTESTATIONS_URL, GITHUB_REPOSITORY, RELEASE_WORKFLOW_PATH } from './config';
import pinnedTrustedRoot from './trusted-root.json';

const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const SLSA_PROVENANCE_V1_TYPE = 'https://slsa.dev/provenance/v1';
const DEFAULT_TAG_REF_PATTERN = /^refs\/tags\/(v[^\s/]+)$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const DIGITS_ONLY = /^\d+$/;

export type BuildVerification =
  | { kind: 'checking' }
  | { kind: 'verified'; tag: string; commit: string; url: string }
  | { kind: 'unverified'; url: string }
  | { kind: 'failed'; reason: string; url: string };

export type VerifiedRelease = {
  tag: string;
  ref: string;
  commit: string;
  /** Signed relative asset path -> lowercase hex SHA-256 digest from the in-toto statement's `subject` array. */
  subjects: ReadonlyMap<string, string>;
};

export type AttestationPolicy = {
  repository: string;
  workflowPath: string;
  trigger?: string;
  /** RegExp matched against `SourceRepositoryRef`; capture group 1 (if present) becomes `tag`. */
  refPattern?: RegExp;
};

export const DEFAULT_ATTESTATION_POLICY: AttestationPolicy = {
  repository: GITHUB_REPOSITORY,
  workflowPath: RELEASE_WORKFLOW_PATH,
  trigger: 'release',
  refPattern: DEFAULT_TAG_REF_PATTERN,
};

/**
 * Policy verifying the Fulcio certificate's ref, commit digest, and exact workflow URI across SAN, BuildConfigURI,
 * and BuildSignerURI, while extracting the verified tag/ref/commit for the caller.
 */
class ReleaseIdentityPolicy implements VerificationPolicy {
  tag = '';
  ref = '';
  commit = '';

  constructor(
    private readonly repository: string,
    private readonly workflowPath: string,
    private readonly refPattern: RegExp,
  ) {}

  verify(cert: X509Certificate): void {
    const ref = cert.extSourceRepositoryRef?.sourceRepositoryRef;
    if (!ref) throw new PolicyError('Certificate is missing SourceRepositoryRef extension');
    const match = this.refPattern.exec(ref);
    if (!match) throw new PolicyError(`Certificate SourceRepositoryRef '${ref}' is not an allowed release ref`);
    const tag = match[1] ?? ref;

    const commit = cert.extSourceRepositoryDigest?.sourceRepositoryDigest;
    if (!commit || !GIT_SHA_PATTERN.test(commit)) {
      throw new PolicyError(`Certificate SourceRepositoryDigest '${commit ?? ''}' is not a valid commit SHA`);
    }

    const expectedWorkflowUri = `https://github.com/${this.repository}/${this.workflowPath}@${ref}`;
    const configUri = cert.extBuildConfigURI?.buildConfigURI;
    if (configUri !== expectedWorkflowUri) {
      throw new PolicyError(`Certificate BuildConfigURI '${configUri ?? ''}' does not match '${expectedWorkflowUri}'`);
    }
    const signerUri = cert.extBuildSignerURI?.buildSignerURI;
    if (signerUri !== expectedWorkflowUri) {
      throw new PolicyError(`Certificate BuildSignerURI '${signerUri ?? ''}' does not match '${expectedWorkflowUri}'`);
    }
    if (cert.subjectAltName !== expectedWorkflowUri) {
      throw new PolicyError(`Certificate SAN '${cert.subjectAltName ?? ''}' does not match '${expectedWorkflowUri}'`);
    }

    this.tag = tag;
    this.ref = ref;
    this.commit = commit;
  }
}

type InTotoStatement = {
  _type?: unknown;
  predicateType?: unknown;
  subject?: unknown;
  predicate?: {
    buildDefinition?: {
      externalParameters?: {
        workflow?: {
          repository?: unknown;
          ref?: unknown;
          path?: unknown;
        };
      };
      resolvedDependencies?: unknown;
    };
  };
};

function parseProvenanceStatement(
  payloadBytes: Uint8Array,
  expected: { repositoryUri: string; workflowPath: string; ref: string; commit: string },
): Map<string, string> {
  const statement = JSON.parse(new TextDecoder().decode(payloadBytes)) as InTotoStatement;
  if (statement._type !== IN_TOTO_STATEMENT_TYPE) {
    throw new Error(`Unexpected in-toto statement type: ${String(statement._type)}`);
  }
  if (statement.predicateType !== SLSA_PROVENANCE_V1_TYPE) {
    throw new Error(`Unexpected provenance predicate type: ${String(statement.predicateType)}`);
  }

  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (
    workflow?.repository !== expected.repositoryUri ||
    workflow?.ref !== expected.ref ||
    workflow?.path !== expected.workflowPath
  ) {
    throw new Error('SLSA provenance workflow parameters do not match the verified signing certificate');
  }

  const deps = statement.predicate?.buildDefinition?.resolvedDependencies;
  const hasCommit =
    Array.isArray(deps) &&
    deps.some(
      (dep) =>
        dep !== null &&
        typeof dep === 'object' &&
        (dep as { digest?: { gitCommit?: unknown } }).digest?.gitCommit === expected.commit,
    );
  if (!hasCommit) {
    throw new Error('SLSA provenance resolvedDependencies does not match the verified commit SHA');
  }

  if (!Array.isArray(statement.subject) || statement.subject.length === 0) {
    throw new Error('SLSA provenance statement has no subjects');
  }

  const subjects = new Map<string, string>();
  for (const entry of statement.subject) {
    if (entry === null || typeof entry !== 'object') throw new Error('Invalid subject entry in provenance statement');
    const { name, digest } = entry as { name?: unknown; digest?: { sha256?: unknown } };
    if (typeof name !== 'string' || name.length === 0) throw new Error('Subject entry is missing a valid name');
    const sha256 = typeof digest?.sha256 === 'string' ? digest.sha256.toLowerCase() : '';
    if (!SHA256_HEX_PATTERN.test(sha256)) {
      throw new Error(`Subject '${name}' does not have a valid SHA-256 digest`);
    }
    const existing = subjects.get(name);
    if (existing !== undefined && existing !== sha256) {
      throw new Error(`Conflicting SHA-256 digests for subject '${name}'`);
    }
    subjects.set(name, sha256);
  }
  return subjects;
}

/** Verifies a GitHub Artifact Attestation Sigstore bundle against the pinned Sigstore root and strict GitHub OIDC policy. */
export async function verifyAttestationBundle(
  bundle: unknown,
  policyConfig: AttestationPolicy = DEFAULT_ATTESTATION_POLICY,
  trustedRoot: TrustedRoot = pinnedTrustedRoot as unknown as TrustedRoot,
): Promise<VerifiedRelease> {
  if (bundle === null || typeof bundle !== 'object') {
    throw new Error('Attestation bundle must be a JSON object');
  }

  const verifier = new SigstoreVerifier({
    tlogThreshold: 1,
    ctlogThreshold: 1,
    bundleVersions: ['0.2', '0.3'],
  });
  await verifier.loadSigstoreRoot(trustedRoot);

  const repositoryUri = `https://github.com/${policyConfig.repository}`;
  const trigger = policyConfig.trigger ?? 'release';
  const refPattern = policyConfig.refPattern ?? DEFAULT_TAG_REF_PATTERN;
  const releaseIdentity = new ReleaseIdentityPolicy(policyConfig.repository, policyConfig.workflowPath, refPattern);

  const policy = new AllOf([
    new OIDCIssuerV2(GITHUB_OIDC_ISSUER),
    new OIDCSourceRepositoryURI(repositoryUri),
    new OIDCRunnerEnvironment('github-hosted'),
    new OIDCBuildTrigger(trigger),
    releaseIdentity,
  ]);

  const { payloadType, payload } = await verifier.verifyDsse(bundle as SigstoreBundle, policy);
  if (payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw new Error(`Unexpected DSSE payload type: ${payloadType}`);
  }

  const subjects = parseProvenanceStatement(payload, {
    repositoryUri,
    workflowPath: policyConfig.workflowPath,
    ref: releaseIdentity.ref,
    commit: releaseIdentity.commit,
  });

  return {
    tag: releaseIdentity.tag,
    ref: releaseIdentity.ref,
    commit: releaseIdentity.commit,
    subjects,
  };
}

/** Computes the lowercase hex SHA-256 digest of `bytes` using Web Crypto. */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return toHex(new Uint8Array(digest));
}

/** Checks that `bytes` match the signed SHA-256 digest recorded for `name` in `subjects`. */
export async function verifyFileDigest(
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  subjects: ReadonlyMap<string, string>,
): Promise<void> {
  const expected = subjects.get(name);
  if (!expected) throw new Error(`'${name}' is not listed in the signed build attestation`);
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for '${name}' (got ${actual.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)`);
  }
}

/** Validates an `attestation-meta.json` payload and returns the GitHub attestation URL (or the repo attestations index). */
export function parseAttestationUrl(meta: unknown, baseUrl: string = ATTESTATIONS_URL): string {
  if (meta !== null && typeof meta === 'object') {
    const id = (meta as { attestationId?: unknown }).attestationId;
    if (typeof id === 'string' && DIGITS_ONLY.test(id)) return `${baseUrl}/${id}`;
  }
  return baseUrl;
}
