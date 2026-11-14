// Finding the Signal accounts of phone numbers, through Signal's contact discovery.
//
// Contact discovery runs inside an enclave: a protected part of a server that Signal's own operators cannot look
// into. The attestation module (crates/attestation-wasm) checks the enclave's attestation, as Signal's apps do, and
// encrypts the phone numbers for the enclave alone. This file fetches the credentials for the service and carries the
// module's messages over a WebSocket through the relay. Neither the migration server nor Signal's servers outside
// the enclave see a phone number.

import { NoAnswerError, REQUEST_TIME_LIMIT_S, withTimeLimit } from '../core/time-limit';
import init, { ContactDiscovery, contactDiscoveryEnclaveId } from '../wasm/attestation_wasm';
import { basicAuthorization } from './session';
import { type MessageChannel, openTunnelWebSocket } from './socket';
import type { SignalAccount } from './transport';

export const CONTACT_DISCOVERY_HOST = 'cdsi.signal.org';

/** A Signal account that a phone number belongs to. */
export type DiscoveredAccount = {
  /** The number as it was asked for: a plus sign and digits. */
  phoneNumber: string;
  /** The account's phone number identity: an ID of the account that is tied to the number. */
  phoneNumberIdentity: string;
  /** The account ID. Contact discovery gives it only to a client that already holds a key of the account. */
  accountId: string | null;
};

/** Signal refused the lookup: the account has looked up too many numbers and may ask again after the wait. */
export class DiscoveryLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Signal allows this account no more lookups of phone numbers for ${retryAfterSeconds} seconds.`);
  }
}

/** The close code with which contact discovery refuses an account that has used up its allowance. */
const ALLOWANCE_USED_UP = 4008;
const NORMAL_CLOSE = 1000;

let loading: Promise<void> | null = null;

/** Loads the attestation module once, before any of its functions are used. */
export function loadAttestationWasm(): Promise<void> {
  loading ??= init({ module_or_path: '/attestation_wasm_bg.wasm' }).then(() => undefined);
  return loading;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The wait that Signal names in the text of its refusal, `{"retry_after": seconds}`. */
function waitNamedIn(reason: string): number {
  try {
    const wait: unknown = (JSON.parse(reason) as { retry_after?: unknown }).retry_after;
    if (typeof wait === 'number' && wait >= 0) return wait;
  } catch {
    // The text is no JSON; the wait is unknown.
  }
  return 0;
}

async function credentials(account: SignalAccount): Promise<{ username: string; password: string }> {
  const response = await account.withChat((chat) => chat.request('GET', '/v2/directory/auth'));
  if (response.status !== 200)
    throw new Error(`asking Signal for contact discovery credentials answered ${response.status}`);
  return JSON.parse(new TextDecoder().decode(response.body)) as { username: string; password: string };
}

export type OpenChannel = (host: string, path: string, headers: string[]) => Promise<MessageChannel>;

/**
 * The Signal accounts of `phoneNumbers`, each a plus sign and digits. A number without an account, or whose owner
 * cannot be found by number, has no entry. Throws a DiscoveryLimitError when Signal refuses the lookup for now.
 */
export async function discoverAccounts(
  account: SignalAccount,
  phoneNumbers: string[],
  open: OpenChannel = openTunnelWebSocket,
  now: () => number = Date.now,
): Promise<DiscoveredAccount[]> {
  const { username, password } = await credentials(account);
  await loadAttestationWasm();
  const enclaveId = contactDiscoveryEnclaveId();
  const channel = await open(CONTACT_DISCOVERY_HOST, `/v1/${hex(enclaveId)}/discovery`, [
    basicAuthorization(username, password),
  ]);

  let lookup: ContactDiscovery | null = null;
  const exchange = new Promise<DiscoveredAccount[]>((resolve, reject) => {
    channel.onMessage = (message) => {
      try {
        if (!lookup) {
          // The enclave speaks first, with its attestation.
          lookup = ContactDiscovery.begin(enclaveId, message, now() / 1000, phoneNumbers);
          channel.send(lookup.handshakeMessage());
          return;
        }
        const answer = lookup.receive(message);
        if (answer) channel.send(answer);
      } catch (error) {
        channel.close();
        reject(error);
      }
    };
    channel.onClose = (code, reason) => {
      if (code === ALLOWANCE_USED_UP) return reject(new DiscoveryLimitError(waitNamedIn(reason)));
      if (code !== NORMAL_CLOSE || !lookup) {
        return reject(new Error(`Signal's contact discovery closed the connection with code ${code}: ${reason}`));
      }
      try {
        resolve(
          lookup.accounts().map((found) => {
            const plain = {
              phoneNumber: found.phoneNumber,
              phoneNumberIdentity: found.phoneNumberIdentity,
              accountId: found.accountId ?? null,
            };
            found.free();
            return plain;
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
  });

  try {
    return await withTimeLimit(exchange, REQUEST_TIME_LIMIT_S * 1000, () => {
      channel.close();
      return new NoAnswerError('Signal', REQUEST_TIME_LIMIT_S);
    });
  } finally {
    (lookup as ContactDiscovery | null)?.free();
  }
}
