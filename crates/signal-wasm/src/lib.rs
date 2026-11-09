//! WebAssembly bindings to the parts of libsignal that linking a device from a browser page needs.
//!
//! Secret keys cross this boundary only as inputs. Nothing here logs or stores them.

use aes::cipher::{KeyIvInit, StreamCipher};
use hmac::{Hmac, KeyInit, Mac};
use libsignal_protocol::kem;
use libsignal_protocol::{KeyPair, PrivateKey, PublicKey};
use libsignal_provisioning::RecvProvisionCiphertextState;
use rand::rngs::OsRng;
use rand::TryRngCore;
use sha2::Sha256;
use wasm_bindgen::prelude::*;

mod tls;

type HmacSha256 = Hmac<Sha256>;
type Aes256Ctr = ctr::Ctr128BE<aes::Aes256>;

pub(crate) fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

/// The new device's side of the linking handshake: a one-time key pair whose public half goes into
/// the QR code, and decryption of the envelope the primary device sends back to it.
#[wasm_bindgen]
pub struct ProvisioningReceiver {
    state: RecvProvisionCiphertextState,
}

#[wasm_bindgen]
impl ProvisioningReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ProvisioningReceiver {
        ProvisioningReceiver { state: RecvProvisionCiphertextState::generate(&mut OsRng.unwrap_err()) }
    }

    /// The 33-byte public key (type byte included) for the `pub_key` parameter of the QR code.
    #[wasm_bindgen(js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> {
        self.state.public_key().to_vec()
    }

    /// Decrypts a serialized `ProvisionEnvelope` into the serialized `ProvisionMessage` it carries.
    #[wasm_bindgen(js_name = decryptEnvelope)]
    pub fn decrypt_envelope(&self, envelope: &[u8]) -> Result<Vec<u8>, JsError> {
        self.state.decrypt_envelope(envelope).map_err(js_error)
    }
}

/// A prekey's public part and its signature by an identity key, as the server's link request takes them.
#[wasm_bindgen(getter_with_clone)]
pub struct SignedPublicPreKey {
    #[wasm_bindgen(js_name = keyId)]
    pub key_id: u32,
    #[wasm_bindgen(js_name = publicKey)]
    pub public_key: Vec<u8>,
    pub signature: Vec<u8>,
}

/// Generates an elliptic-curve signed prekey and signs its public key with the identity key.
/// The private half is discarded: a device that only sends never needs it.
#[wasm_bindgen(js_name = generateSignedPreKey)]
pub fn generate_signed_pre_key(identity_private_key: &[u8], key_id: u32) -> Result<SignedPublicPreKey, JsError> {
    let identity = PrivateKey::deserialize(identity_private_key).map_err(js_error)?;
    let rng = &mut OsRng.unwrap_err();
    let public_key = KeyPair::generate(rng).public_key.serialize().to_vec();
    let signature = identity.calculate_signature(&public_key, rng).map_err(js_error)?.to_vec();
    Ok(SignedPublicPreKey { key_id, public_key, signature })
}

/// Generates a Kyber-1024 last-resort prekey and signs its public key with the identity key.
/// The private half is discarded, as for [`generate_signed_pre_key`].
#[wasm_bindgen(js_name = generateKyberLastResortPreKey)]
pub fn generate_kyber_last_resort_pre_key(identity_private_key: &[u8], key_id: u32) -> Result<SignedPublicPreKey, JsError> {
    let identity = PrivateKey::deserialize(identity_private_key).map_err(js_error)?;
    let rng = &mut OsRng.unwrap_err();
    let public_key = kem::KeyPair::generate(kem::KeyType::Kyber1024, rng).public_key.serialize().to_vec();
    let signature = identity.calculate_signature(&public_key, rng).map_err(js_error)?.to_vec();
    Ok(SignedPublicPreKey { key_id, public_key, signature })
}

/// A device name encrypted to the account's identity key, as the three fields of Signal's `DeviceName` message.
#[wasm_bindgen(getter_with_clone)]
pub struct EncryptedDeviceName {
    #[wasm_bindgen(js_name = ephemeralPublic)]
    pub ephemeral_public: Vec<u8>,
    #[wasm_bindgen(js_name = syntheticIv)]
    pub synthetic_iv: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as KeyInit>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// Encrypts the device name the way Signal Desktop does (`encryptDeviceName` in `ts/Crypto.node.ts`),
/// so the account's other devices can show it.
#[wasm_bindgen(js_name = encryptDeviceName)]
pub fn encrypt_device_name(name: &str, identity_public_key: &[u8]) -> Result<EncryptedDeviceName, JsError> {
    let identity_public = PublicKey::deserialize(identity_public_key).map_err(js_error)?;
    let ephemeral = KeyPair::generate(&mut OsRng.unwrap_err());
    let master_secret = ephemeral.private_key.calculate_agreement(&identity_public).map_err(js_error)?;

    let plaintext = name.as_bytes();
    let synthetic_iv = hmac_sha256(&hmac_sha256(&master_secret, b"auth"), plaintext)[..16].to_vec();
    let cipher_key = hmac_sha256(&hmac_sha256(&master_secret, b"cipher"), &synthetic_iv);

    let mut ciphertext = plaintext.to_vec();
    Aes256Ctr::new(&cipher_key.into(), &[0u8; 16].into()).apply_keystream(&mut ciphertext);

    Ok(EncryptedDeviceName { ephemeral_public: ephemeral.public_key.serialize().to_vec(), synthetic_iv, ciphertext })
}
