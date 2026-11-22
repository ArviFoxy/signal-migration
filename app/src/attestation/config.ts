// Repository and workflow identity used by both the UI links and the Sigstore build-attestation verifier.
// Keeping this in one file makes moving the repository (for example, to a GitHub organization) a single-line change.

export const GITHUB_REPOSITORY = 'ArviFoxy/signal-migration';
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_REPOSITORY}`;
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';
export const ATTESTATIONS_URL = `${GITHUB_REPOSITORY_URL}/attestations`;
