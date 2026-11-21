//! Signal's storage service, sticker pack, and attachment encryption, built on libsignal's crates (`signal-crypto`
//! for HMAC, AES-GCM and AES-CBC; `libsignal-account-keys` for the storage service key).
//!
//! Storage service (Signal Desktop `ts/Crypto.node.ts`, Signal Android `StorageKey.kt` and `RecordIkm.kt`):
//!   manifest key   = HMAC-SHA256(storage service key, "Manifest_<version>")
//!   record key     = HKDF-SHA256(recordIkm, info "20240801_SIGNAL_STORAGE_SERVICE_ITEM_" || record id), or
//!                    HMAC-SHA256(storage service key, "Item_<padded base64 record id>") without a recordIkm
//!   encrypted blob = 12-byte nonce || AES-256-GCM ciphertext || 16-byte tag
//! Sticker packs (Signal Android `AttachmentCipherInputStream.createForStickerData`):
//!   keys           = HKDF-SHA256(pack key, info "Sticker Pack", 64 bytes): AES-256 key, then HMAC-SHA256 key
//!   encrypted file = 16-byte IV || AES-256-CBC ciphertext || HMAC-SHA256 over IV and ciphertext
//! Message attachments (Signal Desktop `AttachmentCrypto.node.ts`, Signal Android `AttachmentCipherOutputStream.kt`
//! and `PaddingInputStream.java`):
//!   key            = 64 random bytes: AES-256 key (first 32), then HMAC-SHA256 key (last 32)
//!   padded         = plaintext || zeros up to max(541, floor(1.05^ceil(log_1.05(plaintext.len()))))
//!   encrypted file = 16-byte IV || AES-256-CBC(padded, PKCS#7) || HMAC-SHA256(IV || ciphertext)
//!   digest         = SHA-256(IV || ciphertext || HMAC)

use std::str::FromStr;

use aes::Aes256;
use aes::cipher::{BlockModeEncrypt, KeyIvInit};
use base64::Engine;
use cbc::Encryptor;
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use libsignal_account_keys::{AccountEntropyPool, SvrKey};
use rand::rngs::OsRng;
use rand::{Rng, TryRngCore};
use sha2::{Digest, Sha256};
use signal_crypto::{
    Aes256GcmDecryption, Aes256GcmEncryption, CryptographicMac, aes_256_cbc_decrypt, aes_256_cbc_encrypt,
};
use subtle::ConstantTimeEq;
use wasm_bindgen::prelude::*;

use crate::js_error;

pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = CryptographicMac::new("HmacSha256", key).expect("HmacSha256 is a known algorithm");
    mac.update(data);
    mac.finalize()
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng
        .try_fill_bytes(&mut bytes)
        .expect("the browser provides randomness");
    bytes
}

/// A whole number from `min` to `max`, each equally likely, drawn with the `rand` library from the browser's
/// generator. `rand` draws again where a remainder would make some numbers more likely than others.
fn uniform(min: u32, max: u32) -> u32 {
    OsRng.unwrap_err().random_range(min..=max)
}

/// A random whole number from `min` to `max`, each equally likely.
#[wasm_bindgen(js_name = randomInt)]
pub fn random_int(min: u32, max: u32) -> Result<u32, JsError> {
    if min > max {
        return Err(JsError::new("the smallest number is above the largest"));
    }
    Ok(uniform(min, max))
}

fn key32(bytes: &[u8]) -> Result<[u8; 32], JsError> {
    bytes.try_into().map_err(|_| JsError::new("expected a 32-byte key"))
}

/// The storage service key from the 32-byte master key (the provisioning message's `masterKey`).
#[wasm_bindgen(js_name = storageServiceKeyFromMasterKey)]
pub fn storage_service_key_from_master_key(master_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(SvrKey::new(key32(master_key)?).derive_storage_service_key().to_vec())
}

/// The storage service key from the account entropy pool (the provisioning message's `accountEntropyPool`).
#[wasm_bindgen(js_name = storageServiceKeyFromAccountEntropyPool)]
pub fn storage_service_key_from_account_entropy_pool(pool: &str) -> Result<Vec<u8>, JsError> {
    let pool = AccountEntropyPool::from_str(pool).map_err(|_| JsError::new("invalid account entropy pool"))?;
    Ok(SvrKey::new(pool.derive_svr_key()).derive_storage_service_key().to_vec())
}

#[wasm_bindgen(js_name = storageManifestKey)]
pub fn storage_manifest_key(storage_service_key: &[u8], version: u64) -> Vec<u8> {
    hmac_sha256(storage_service_key, format!("Manifest_{version}").as_bytes())
}

/// `record_ikm` empty means the manifest has none.
#[wasm_bindgen(js_name = storageRecordKey)]
pub fn storage_record_key(storage_service_key: &[u8], record_ikm: &[u8], record_id: &[u8]) -> Vec<u8> {
    if record_ikm.is_empty() {
        let id = base64::engine::general_purpose::STANDARD.encode(record_id);
        return hmac_sha256(storage_service_key, format!("Item_{id}").as_bytes());
    }
    let info = [b"20240801_SIGNAL_STORAGE_SERVICE_ITEM_".as_slice(), record_id].concat();
    let mut key = vec![0u8; 32];
    Hkdf::<Sha256>::new(None, record_ikm)
        .expand(&info, &mut key)
        .expect("32 bytes is a valid HKDF output length");
    key
}

#[wasm_bindgen(js_name = encryptStorageBlob)]
pub fn encrypt_storage_blob(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
    let nonce: [u8; 12] = random_bytes();
    let mut encryption = Aes256GcmEncryption::new(key, &nonce, &[]).map_err(js_error)?;
    let mut buffer = plaintext.to_vec();
    encryption.encrypt(&mut buffer);
    Ok([nonce.as_slice(), &buffer, &encryption.compute_tag()].concat())
}

#[wasm_bindgen(js_name = decryptStorageBlob)]
pub fn decrypt_storage_blob(key: &[u8], blob: &[u8]) -> Result<Vec<u8>, JsError> {
    if blob.len() < 12 + 16 {
        return Err(JsError::new("encrypted storage blob is too short"));
    }
    let (nonce, rest) = blob.split_at(12);
    let (ciphertext, tag) = rest.split_at(rest.len() - 16);
    let mut decryption = Aes256GcmDecryption::new(key, nonce, &[]).map_err(js_error)?;
    let mut buffer = ciphertext.to_vec();
    decryption.decrypt(&mut buffer);
    decryption
        .verify_tag(tag)
        .map_err(|_| JsError::new("storage blob failed authentication: wrong key or altered data"))?;
    Ok(buffer)
}

fn sticker_keys(pack_key: &[u8]) -> ([u8; 32], [u8; 32]) {
    let mut derived = [0u8; 64];
    Hkdf::<Sha256>::new(None, pack_key)
        .expand(b"Sticker Pack", &mut derived)
        .expect("64 bytes is a valid HKDF output length");
    (
        derived[..32].try_into().expect("32 bytes"),
        derived[32..].try_into().expect("32 bytes"),
    )
}

#[wasm_bindgen(js_name = encryptStickerFile)]
pub fn encrypt_sticker_file(plaintext: &[u8], pack_key: &[u8]) -> Result<Vec<u8>, JsError> {
    let (aes_key, mac_key) = sticker_keys(pack_key);
    let iv: [u8; 16] = random_bytes();
    let ciphertext = aes_256_cbc_encrypt(plaintext, &aes_key, &iv).map_err(js_error)?;
    let authenticated = [iv.as_slice(), &ciphertext].concat();
    let mac = hmac_sha256(&mac_key, &authenticated);
    Ok([authenticated, mac].concat())
}

/// Verifies the HMAC (an error means a wrong pack key or an altered file) and decrypts.
#[wasm_bindgen(js_name = decryptStickerFile)]
pub fn decrypt_sticker_file(data: &[u8], pack_key: &[u8]) -> Result<Vec<u8>, JsError> {
    if data.len() < 16 + 16 + 32 {
        return Err(JsError::new("file is shorter than the encryption overhead"));
    }
    let (aes_key, mac_key) = sticker_keys(pack_key);
    let (authenticated, mac) = data.split_at(data.len() - 32);
    if !bool::from(hmac_sha256(&mac_key, authenticated).ct_eq(mac)) {
        return Err(JsError::new("HMAC mismatch: wrong pack key or altered file"));
    }
    let (iv, ciphertext) = authenticated.split_at(16);
    aes_256_cbc_decrypt(ciphertext, &aes_key, iv).map_err(js_error)
}

/// Signal's padded plaintext length for an attachment of `plaintext_len` bytes:
/// `max(541, floor(1.05 ^ ceil(log_1.05(plaintext_len))))` (Signal Desktop `logPadSize.std.ts`,
/// Signal Android `PaddingInputStream.getPaddedSize`).
#[wasm_bindgen(js_name = paddedAttachmentSize)]
pub fn padded_attachment_size(plaintext_len: u32) -> u32 {
    if plaintext_len <= 541 {
        return 541;
    }
    let exponent = (plaintext_len as f64).ln() / 1.05_f64.ln();
    let padded = 1.05_f64.powf(exponent.ceil()).floor() as u32;
    padded.max(541).max(plaintext_len)
}

/// Exact encrypted byte length uploaded to Signal's CDN for an attachment of `plaintext_len` bytes:
/// 16-byte IV + AES-256-CBC(padded plaintext, PKCS#7) + 32-byte HMAC-SHA256.
#[wasm_bindgen(js_name = encryptedAttachmentSize)]
pub fn encrypted_attachment_size(plaintext_len: u32) -> u32 {
    let padded = padded_attachment_size(plaintext_len);
    let cbc = (padded / 16 + 1) * 16;
    16 + cbc + 32
}

/// The trailing bytes and metadata produced when `AttachmentEncryptor.finish()` runs.
#[wasm_bindgen(getter_with_clone)]
pub struct EncryptedAttachmentEnd {
    /// Final ciphertext blocks (zero-padding + PKCS#7 block) followed by the 32-byte HMAC-SHA256.
    pub tail: Vec<u8>,
    /// The 64-byte attachment key (32-byte AES-256 key || 32-byte HMAC-SHA256 key).
    pub key: Vec<u8>,
    /// SHA-256 over IV || ciphertext || HMAC.
    pub digest: Vec<u8>,
    #[wasm_bindgen(js_name = ciphertextSize)]
    pub ciphertext_size: u32,
}

/// Streaming Signal attachment encryptor so large files (up to ~95 MiB) never need to be held in memory at once.
#[wasm_bindgen]
pub struct AttachmentEncryptor {
    key: [u8; 64],
    iv: [u8; 16],
    iv_emitted: bool,
    cipher: Encryptor<Aes256>,
    mac: Hmac<Sha256>,
    digest: Sha256,
    pending: [u8; 16],
    pending_len: usize,
    written: u32,
    expected_plaintext: u32,
    finished: bool,
}

#[wasm_bindgen]
impl AttachmentEncryptor {
    #[wasm_bindgen(constructor)]
    pub fn new(plaintext_size: u32) -> AttachmentEncryptor {
        let key: [u8; 64] = random_bytes();
        let iv: [u8; 16] = random_bytes();
        Self::with_key_and_iv(plaintext_size, key, iv)
    }

    /// Encrypts one plaintext chunk, returning the ciphertext bytes produced so far (prepended with the IV on the
    /// first call). Any partial trailing block is held until the next `push` or `finish`.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>, JsError> {
        if self.finished {
            return Err(JsError::new("attachment encryptor has already finished"));
        }
        let next_written = self
            .written
            .checked_add(u32::try_from(chunk.len()).map_err(|_| JsError::new("chunk too large"))?)
            .ok_or_else(|| JsError::new("attachment exceeds expected size"))?;
        if next_written > self.expected_plaintext {
            return Err(JsError::new("attachment exceeds expected plaintext size"));
        }
        self.written = next_written;

        let extra_iv = if self.iv_emitted { 0 } else { 16 };
        let mut out = Vec::with_capacity(extra_iv + ((self.pending_len + chunk.len()) / 16) * 16);
        self.emit_iv(&mut out);
        self.feed_plaintext(chunk, &mut out);
        Ok(out)
    }

    /// Appends Signal's logarithmic zero padding, PKCS#7 final block, and HMAC-SHA256, returning the final bytes
    /// together with the 64-byte key and SHA-256 digest of the complete encrypted stream.
    pub fn finish(&mut self) -> Result<EncryptedAttachmentEnd, JsError> {
        if self.finished {
            return Err(JsError::new("attachment encryptor has already finished"));
        }
        if self.written != self.expected_plaintext {
            return Err(JsError::new("attachment plaintext length did not match expected size"));
        }
        self.finished = true;

        let padded_len = padded_attachment_size(self.expected_plaintext);
        let pad_zeros = (padded_len - self.expected_plaintext) as usize;
        let extra_iv = if self.iv_emitted { 0 } else { 16 };
        let mut tail = Vec::with_capacity(extra_iv + pad_zeros + 16 + 32);
        self.emit_iv(&mut tail);

        const ZERO_BUF: [u8; 4096] = [0u8; 4096];
        let mut remaining = pad_zeros;
        while remaining > 0 {
            let step = remaining.min(ZERO_BUF.len());
            self.feed_plaintext(&ZERO_BUF[..step], &mut tail);
            remaining -= step;
        }

        // PKCS#7 padding: 1..=16 bytes each equal to the padding length.
        let pkcs7_len = 16 - self.pending_len;
        self.pending[self.pending_len..].fill(pkcs7_len as u8);
        let mut block = self.pending;
        self.pending_len = 0;
        self.encrypt_block(&mut block, &mut tail);

        let mac = self.mac.clone().finalize().into_bytes();
        self.digest.update(&mac);
        tail.extend_from_slice(&mac);
        let digest = self.digest.clone().finalize().to_vec();

        Ok(EncryptedAttachmentEnd {
            tail,
            key: self.key.to_vec(),
            digest,
            ciphertext_size: encrypted_attachment_size(self.expected_plaintext),
        })
    }
}

impl AttachmentEncryptor {
    fn with_key_and_iv(plaintext_size: u32, key: [u8; 64], iv: [u8; 16]) -> AttachmentEncryptor {
        let cipher = Encryptor::<Aes256>::new_from_slices(&key[..32], &iv).expect("32-byte key and 16-byte IV");
        let mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&key[32..]).expect("32-byte HMAC key");
        AttachmentEncryptor {
            key,
            iv,
            iv_emitted: false,
            cipher,
            mac,
            digest: Sha256::new(),
            pending: [0u8; 16],
            pending_len: 0,
            written: 0,
            expected_plaintext: plaintext_size,
            finished: false,
        }
    }

    fn emit_iv(&mut self, out: &mut Vec<u8>) {
        if self.iv_emitted {
            return;
        }
        self.iv_emitted = true;
        self.mac.update(&self.iv);
        self.digest.update(&self.iv);
        out.extend_from_slice(&self.iv);
    }

    fn encrypt_block(&mut self, block: &mut [u8; 16], out: &mut Vec<u8>) {
        self.cipher.encrypt_block(block.into());
        self.mac.update(&*block);
        self.digest.update(&*block);
        out.extend_from_slice(&*block);
    }

    fn feed_plaintext(&mut self, mut input: &[u8], out: &mut Vec<u8>) {
        if self.pending_len > 0 {
            let take = (16 - self.pending_len).min(input.len());
            self.pending[self.pending_len..self.pending_len + take].copy_from_slice(&input[..take]);
            self.pending_len += take;
            input = &input[take..];
            if self.pending_len == 16 {
                let mut block = self.pending;
                self.pending_len = 0;
                self.encrypt_block(&mut block, out);
            }
        }
        let mut chunks = input.chunks_exact(16);
        for chunk in chunks.by_ref() {
            let mut block: [u8; 16] = chunk.try_into().expect("16 bytes");
            self.encrypt_block(&mut block, out);
        }
        let rem = chunks.remainder();
        if !rem.is_empty() {
            self.pending[..rem.len()].copy_from_slice(rem);
            self.pending_len = rem.len();
        }
    }
}

/// Verifies digest and HMAC and decrypts a Signal attachment back to its `size` plaintext bytes.
#[wasm_bindgen(js_name = decryptAttachment)]
pub fn decrypt_attachment(data: &[u8], key: &[u8], digest: &[u8], size: u32) -> Result<Vec<u8>, JsError> {
    if key.len() != 64 {
        return Err(JsError::new("expected a 64-byte attachment key"));
    }
    if data.len() < 16 + 16 + 32 {
        return Err(JsError::new("attachment is shorter than the encryption overhead"));
    }
    let actual_digest = Sha256::digest(data);
    if !bool::from(actual_digest.as_slice().ct_eq(digest)) {
        return Err(JsError::new("attachment digest mismatch"));
    }
    let (authenticated, mac) = data.split_at(data.len() - 32);
    if !bool::from(hmac_sha256(&key[32..], authenticated).ct_eq(mac)) {
        return Err(JsError::new("attachment HMAC mismatch"));
    }
    let (iv, ciphertext) = authenticated.split_at(16);
    let mut padded = aes_256_cbc_decrypt(ciphertext, &key[..32], iv).map_err(js_error)?;
    let size = size as usize;
    if padded.len() < size {
        return Err(JsError::new("decrypted attachment is shorter than its stated size"));
    }
    padded.truncate(size);
    Ok(padded)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Detects: a number outside the range, or a range whose last number never comes up because its end was left
    // out. Missing an end of a range of four numbers by chance in 2000 draws has a likelihood below 10^-240.
    #[test]
    fn a_random_number_stays_in_its_range_and_reaches_both_ends() {
        let drawn: Vec<u32> = (0..2000).map(|_| uniform(7, 10)).collect();
        assert!(drawn.iter().all(|number| (7..=10).contains(number)));
        assert!(drawn.contains(&7) && drawn.contains(&10));
        assert_eq!(uniform(5, 5), 5);
    }

    // Detects: divergence from Signal's logarithmic padding buckets (PaddingInputStream.java / logPadSize.std.ts).
    #[test]
    fn padded_attachment_sizes_match_signal() {
        assert_eq!(padded_attachment_size(0), 541);
        assert_eq!(padded_attachment_size(1), 541);
        assert_eq!(padded_attachment_size(541), 541);
        assert_eq!(padded_attachment_size(542), 568);
        assert_eq!(padded_attachment_size(1000), 1020);
        assert_eq!(padded_attachment_size(10_000), 10_110);
    }

    // Detects: block-boundary or streaming bugs in AttachmentEncryptor compared to one-shot Signal AES-CBC + HMAC + SHA-256.
    #[test]
    fn streaming_attachment_encryptor_matches_one_shot_and_decrypts() {
        let key = [0x42u8; 64];
        let iv = [0x11u8; 16];
        for len in [0usize, 1, 15, 16, 17, 541, 542, 4096, 10_003] {
            let plaintext: Vec<u8> = (0..len).map(|i| (i * 31 + 7) as u8).collect();

            // One-shot reference using signal_crypto directly.
            let padded_len = padded_attachment_size(len as u32) as usize;
            let mut padded = plaintext.clone();
            padded.resize(padded_len, 0);
            let cbc = aes_256_cbc_encrypt(&padded, &key[..32], &iv).unwrap();
            let authenticated = [iv.as_slice(), &cbc].concat();
            let mac = hmac_sha256(&key[32..], &authenticated);
            let expected = [authenticated, mac].concat();
            let expected_digest = Sha256::digest(&expected).to_vec();

            // Streaming with irregular chunk sizes (3, 13, 16, 257 bytes).
            let mut enc = AttachmentEncryptor::with_key_and_iv(len as u32, key, iv);
            let mut streamed = Vec::new();
            let mut offset = 0;
            for step in [3usize, 13, 16, 257].into_iter().cycle() {
                if offset >= plaintext.len() {
                    break;
                }
                let end = (offset + step).min(plaintext.len());
                streamed.extend_from_slice(&enc.push(&plaintext[offset..end]).unwrap());
                offset = end;
            }
            let finished = enc.finish().unwrap();
            streamed.extend_from_slice(&finished.tail);

            assert_eq!(streamed.len(), encrypted_attachment_size(len as u32) as usize);
            assert_eq!(finished.ciphertext_size as usize, streamed.len());
            assert_eq!(streamed, expected);
            assert_eq!(finished.digest, expected_digest);
            assert_eq!(
                decrypt_attachment(&streamed, &finished.key, &finished.digest, len as u32).unwrap(),
                plaintext
            );
        }
    }
}
