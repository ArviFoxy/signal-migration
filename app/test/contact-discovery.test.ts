// The page's part of a lookup at Signal's contact discovery: credentials, the connection, and what a close means.
// The exchange with the enclave itself is tested in crates/attestation-wasm, against a stand-in enclave.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CONTACT_DISCOVERY_HOST, DiscoveryLimitError, discoverAccounts } from '../src/signal/contact-discovery';
import type { MessageChannel } from '../src/signal/socket';
import type { ChatResponse, SignalAccount } from '../src/signal/transport';
import { initSync } from '../src/wasm/attestation_wasm';

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../src/wasm/attestation_wasm_bg.wasm', import.meta.url)) });
});

const answer = (status: number, body: object): ChatResponse => ({
  status,
  message: '',
  headers: [],
  body: new TextEncoder().encode(JSON.stringify(body)),
});

/** An account whose chat connection answers the request for contact discovery credentials with `response`. */
const accountAnswering = (response: ChatResponse) =>
  ({ withChat: (action) => action({ request: () => Promise.resolve(response) }) }) as SignalAccount;

const withCredentials = accountAnswering(answer(200, { username: 'user', password: 'secret' }));

/** A connection on which the server does `serverActs` once the lookup listens. */
function connection(serverActs: (channel: MessageChannel) => void) {
  const opened: { host: string; path: string; headers: string[] }[] = [];
  const sent: Uint8Array[] = [];
  let closedByClient = false;
  const open = (host: string, path: string, headers: string[]) => {
    opened.push({ host, path, headers });
    const channel: MessageChannel = {
      send: (bytes) => void sent.push(bytes),
      close: () => void (closedByClient = true),
      onMessage: () => undefined,
      onClose: () => undefined,
    };
    // The real channel keeps what arrives before a handler is set; this one simply acts after the lookup listens.
    setTimeout(() => serverActs(channel), 0);
    return Promise.resolve(channel);
  };
  return { open, opened, sent, wasClosedByClient: () => closedByClient };
}

describe('a lookup at contact discovery', () => {
  it('connects to the enclave named by its ID, with the credentials Signal gave', async () => {
    const { open, opened } = connection((channel) => channel.onClose(1000, ''));
    await expect(discoverAccounts(withCredentials, ['+12025550100'], open)).rejects.toThrow();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.host).toBe(CONTACT_DISCOVERY_HOST);
    expect(opened[0]!.path).toMatch(/^\/v1\/[0-9a-f]{64}\/discovery$/);
    expect(opened[0]!.headers).toEqual([`Authorization: Basic ${btoa('user:secret')}`]);
  });

  it('reports the wait when Signal refuses the lookup because the allowance is used up', async () => {
    const { open } = connection((channel) => channel.onClose(4008, '{"retry_after": 3600}'));
    const refused = await discoverAccounts(withCredentials, ['+12025550100'], open).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DiscoveryLimitError);
    expect((refused as DiscoveryLimitError).retryAfterSeconds).toBe(3600);
  });

  it('sends nothing and closes when the attestation does not pass the check', async () => {
    const { open, sent, wasClosedByClient } = connection((channel) => channel.onMessage(new Uint8Array(64)));
    await expect(discoverAccounts(withCredentials, ['+12025550100'], open)).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(wasClosedByClient()).toBe(true);
  });

  it('fails when the connection closes before the enclave sent anything', async () => {
    const { open } = connection((channel) => channel.onClose(1000, ''));
    await expect(discoverAccounts(withCredentials, ['+12025550100'], open)).rejects.toThrow(/closed the connection/);
  });

  it('does not connect when Signal gives no credentials', async () => {
    const { open, opened } = connection(() => undefined);
    await expect(discoverAccounts(accountAnswering(answer(401, {})), ['+12025550100'], open)).rejects.toThrow(/401/);
    expect(opened).toHaveLength(0);
  });
});
