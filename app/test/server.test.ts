import { describe, expect, it } from 'vitest';
import { normalizeBackendOrigin, serverHttpUrl, serverWsUrl } from '../src/core/server';

describe('server URL resolution', () => {
  // Detects: backend origins containing paths, trailing slashes, or non-HTTP schemes being silently accepted.
  it('validates and normalizes backend origins', () => {
    expect(normalizeBackendOrigin(undefined)).toBe('');
    expect(normalizeBackendOrigin('')).toBe('');
    expect(normalizeBackendOrigin('   ')).toBe('');
    expect(normalizeBackendOrigin('https://signal.vixhole.fun')).toBe('https://signal.vixhole.fun');
    expect(normalizeBackendOrigin('https://signal.vixhole.fun/')).toBe('https://signal.vixhole.fun');
    expect(normalizeBackendOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');

    expect(() => normalizeBackendOrigin('https://signal.vixhole.fun/api')).toThrow();
    expect(() => normalizeBackendOrigin('https://signal.vixhole.fun?x=1')).toThrow();
    expect(() => normalizeBackendOrigin('ftp://signal.vixhole.fun')).toThrow();
    expect(() => normalizeBackendOrigin('not a url')).toThrow();
  });

  // Detects: HTTP and WebSocket URLs breaking in either same-origin (dev/LAN) or cross-origin (GitHub Pages) mode.
  it('resolves same-origin and cross-origin HTTP and WebSocket URLs', () => {
    expect(serverHttpUrl('/v1/config', '')).toBe('/v1/config');
    expect(serverHttpUrl('/v1/config', 'https://signal.vixhole.fun')).toBe('https://signal.vixhole.fun/v1/config');
    expect(serverHttpUrl('/v1/sticker-packs/index?from=10', 'http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1/sticker-packs/index?from=10',
    );
    expect(() => serverHttpUrl('v1/config', '')).toThrow();

    expect(serverWsUrl('/tunnel/chat.signal.org', '', { protocol: 'https:', host: 'signal.vixhole.fun' })).toBe(
      'wss://signal.vixhole.fun/tunnel/chat.signal.org',
    );
    expect(serverWsUrl('/tunnel/chat.signal.org', '', { protocol: 'http:', host: '127.0.0.1:8080' })).toBe(
      'ws://127.0.0.1:8080/tunnel/chat.signal.org',
    );
    expect(
      serverWsUrl('/tunnel/chat.signal.org', 'https://signal.vixhole.fun', {
        protocol: 'https:',
        host: 'arvifoxy.github.io',
      }),
    ).toBe('wss://signal.vixhole.fun/tunnel/chat.signal.org');
    expect(
      serverWsUrl('/tunnel/chat.signal.org', 'http://127.0.0.1:8080', {
        protocol: 'https:',
        host: 'arvifoxy.github.io',
      }),
    ).toBe('ws://127.0.0.1:8080/tunnel/chat.signal.org');
  });
});
