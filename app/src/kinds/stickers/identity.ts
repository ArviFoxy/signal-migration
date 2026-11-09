// The identity of a Telegram sticker pack, and the keys derived from it.
//
// Everyone who has the same Telegram pack computes the same values, so the first person to migrate it uploads it to
// Signal and everyone else installs that upload:
// - `packKey` (contentPackKey) is the Signal pack key of an upload. Signal lets the uploader choose the key, so it is
//   derived from the pack's content: its title and each sticker's original file and emoji, in pack order. Only
//   someone who has every sticker of the pack can compute it (convergent encryption).
// - `lookupKey` is what the sticker pack index stores. It is derived from the pack's identity: its title and each
//   sticker's Telegram file identifier and emoji, in pack order, which are known before anything is downloaded. HKDF
//   under its own label makes it independent of every key: the index learns no pack key, and which Telegram pack an
//   entry belongs to only if it already has that pack.
//
// When the owner changes the pack on Telegram, its identity and content change, and the changed pack is migrated as
// a new Signal pack.

const encoder = new TextEncoder();
const IDENTITY_DOMAIN = 'signal-migration sticker pack v1';
const CONTENT_DOMAIN = 'signal-migration sticker pack content v2';
const PACK_KEY_LABEL = 'signal-migration pack key v2';
const LOOKUP_KEY_LABEL = 'signal-migration sticker-pack lookup v1';

export type PackSource = { title: string; stickers: { uniqueId: string; emoji: string }[] };
export type PackContent = { title: string; stickers: { file: Uint8Array; emoji: string }[] };
export type PackIdentity = { sourceId: Uint8Array; lookupKey: Uint8Array };

/** The domain label, then each field prefixed with its length, so that different packs never encode the same. */
function encodeFields(domain: string, title: string, stickers: Uint8Array[][]): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(domain)];
  const lengthPrefix = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value);
    return bytes;
  };
  const field = (bytes: Uint8Array) => parts.push(lengthPrefix(bytes.length), bytes);
  field(encoder.encode(title));
  parts.push(lengthPrefix(stickers.length));
  for (const fields of stickers) for (const bytes of fields) field(bytes);
  const encoded = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    encoded.set(part, offset);
    offset += part.length;
  }
  return encoded;
}

export function encodePackSource(source: PackSource): Uint8Array {
  return encodeFields(
    IDENTITY_DOMAIN,
    source.title,
    source.stickers.map((sticker) => [encoder.encode(sticker.uniqueId), encoder.encode(sticker.emoji)]),
  );
}

export function encodePackContent(content: PackContent): Uint8Array {
  return encodeFields(
    CONTENT_DOMAIN,
    content.title,
    content.stickers.map((sticker) => [sticker.file, encoder.encode(sticker.emoji)]),
  );
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}

async function hkdf(inputKey: Uint8Array, label: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', inputKey as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(label) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function packIdentity(source: PackSource): Promise<PackIdentity> {
  const sourceId = await sha256(encodePackSource(source));
  return { sourceId, lookupKey: await hkdf(sourceId, LOOKUP_KEY_LABEL) };
}

/** The Signal pack key of a pack, from its content: the title and every sticker's original file and emoji. */
export async function contentPackKey(content: PackContent): Promise<Uint8Array> {
  return hkdf(await sha256(encodePackContent(content)), PACK_KEY_LABEL);
}
