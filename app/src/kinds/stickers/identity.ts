// The identity of a Telegram sticker pack and the two values derived from it.
//
// Everyone who has the same Telegram pack computes the same identity, so the first person to migrate it uploads
// it to Signal and everyone else installs that upload:
// - `packKey` is the Signal pack key of the upload. Signal lets the uploader choose the key, so it is derived
//   rather than random.
// - `lookupKey` is what the sticker pack index stores. HKDF under separate labels makes the two independent:
//   the index learns neither the pack key nor which Telegram pack an entry belongs to, unless it already has
//   that Telegram pack and computes the same values.
//
// The identity covers the title and each sticker's Telegram file identifier and emoji, in pack order. When the
// owner changes the pack on Telegram, its identity changes and the changed pack is migrated as a new Signal pack.

const encoder = new TextEncoder();
const DOMAIN = 'signal-migration sticker pack v1';
const PACK_KEY_LABEL = 'signal-migration pack key v1';
const LOOKUP_KEY_LABEL = 'signal-migration sticker-pack lookup v1';

export type PackSource = { title: string; stickers: { uniqueId: string; emoji: string }[] };
export type PackIdentity = { sourceId: Uint8Array; packKey: Uint8Array; lookupKey: Uint8Array };

/** The domain label, then each field prefixed with its length, so that different packs never encode the same. */
export function encodePackSource(source: PackSource): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(DOMAIN)];
  const lengthPrefix = (value: number) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value);
    return bytes;
  };
  const field = (text: string) => {
    const bytes = encoder.encode(text);
    parts.push(lengthPrefix(bytes.length), bytes);
  };
  field(source.title);
  parts.push(lengthPrefix(source.stickers.length));
  for (const sticker of source.stickers) {
    field(sticker.uniqueId);
    field(sticker.emoji);
  }
  const encoded = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    encoded.set(part, offset);
    offset += part.length;
  }
  return encoded;
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
  const sourceId = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encodePackSource(source) as Uint8Array<ArrayBuffer>),
  );
  return { sourceId, packKey: await hkdf(sourceId, PACK_KEY_LABEL), lookupKey: await hkdf(sourceId, LOOKUP_KEY_LABEL) };
}
