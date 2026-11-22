// Resolves HTTP and WebSocket URLs for the migration backend server.
//
// When the frontend is served by the backend itself (development, LAN, integration tests), BACKEND_ORIGIN is empty and
// requests go to the page's own origin. When the frontend is hosted statically on GitHub Pages, the build injects the
// backend's origin (e.g. "https://signal.vixhole.fun") at build time via esbuild `define`.

declare const __BACKEND_ORIGIN__: string | undefined;

/** Normalizes a backend origin string to `scheme://host[:port]` with no path or trailing slash, or empty for same-origin. */
export function normalizeBackendOrigin(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid backend origin: ${trimmed}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`backend origin must use http or https: ${trimmed}`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`backend origin must not include a path, query or fragment: ${trimmed}`);
  }
  return parsed.origin;
}

const configuredOrigin = normalizeBackendOrigin(
  typeof __BACKEND_ORIGIN__ === 'string' ? __BACKEND_ORIGIN__ : undefined,
);

/** The build-time backend origin, or empty string when using the page's own origin. */
export function backendOrigin(): string {
  return configuredOrigin;
}

/** An HTTP(S) URL for `path` on the migration server. */
export function serverHttpUrl(path: string, origin: string = configuredOrigin): string {
  if (!path.startsWith('/')) throw new Error(`server path must start with '/': ${path}`);
  const normalized = normalizeBackendOrigin(origin);
  return normalized ? `${normalized}${path}` : path;
}

/** A WebSocket (`ws:` / `wss:`) URL for `path` on the migration server. */
export function serverWsUrl(
  path: string,
  origin: string = configuredOrigin,
  pageLocation: Pick<Location, 'protocol' | 'host'> = location,
): string {
  if (!path.startsWith('/')) throw new Error(`server path must start with '/': ${path}`);
  const normalized = normalizeBackendOrigin(origin);
  if (normalized) {
    const parsed = new URL(normalized);
    const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${parsed.host}${path}`;
  }
  const scheme = pageLocation.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${pageLocation.host}${path}`;
}
