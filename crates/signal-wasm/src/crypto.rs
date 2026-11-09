//! Signal's storage service and sticker pack encryption, built on libsignal's crates (`signal-crypto` for HMAC,
//! AES-GCM and AES-CBC; `libsignal-account-keys` for the storage service key).
//!
//! Storage service (Signal Desktop `ts/Crypto.node.ts`, Signal Android `StorageKey.kt` and `RecordIkm.kt`):
//!   manifest key   = HMAC-SHA256(storage service key, "Manifest_<version>")
//!   record key     = HKDF-SHA256(recordIkm, info "20240801_SIGNAL_STORAGE_SERVICE_ITEM_" || record id), or
//!                    HMAC-SHA256(storage service key, "Item_<padded base64 record id>") without a recordIkm
//!   encrypted blob = 12-byte nonce || AES-256-GCM ciphertext || 16-byte tag
//! Sticker packs (Signal Android `AttachmentCipherInputStream.createForStickerData`):
//!   keys           = HKDF-SHA256(pack key, info "Sticker Pack", 64 bytes): AES-256 key, then HMAC-SHA256 key
//!   encrypted file = 16-byte IV || AES-256-CBC ciphertext || HMAC-SHA256 over IV and ciphertext

use std::str::FromStr;

use base64::Engine;
use hkdf::Hkdf;
use libsignal_account_keys::{AccountEntropyPool, SvrKey};
use rand::TryRngCore;
use rand::rngs::OsRng;
use sha2::Sha256;
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
