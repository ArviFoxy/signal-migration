//! Messages from the linked device to the account's other devices (the phone and any other linked device),
//! encrypted with libsignal-protocol. A session with each device starts from the device's prekey bundle, which the
//! server hands out (PQXDH: the identity key, a signed prekey, a Kyber prekey and possibly a one-time prekey). The
//! sessions live in memory for as long as the page keeps this object.

use std::time::SystemTime;

use futures_util::FutureExt;
use libsignal_protocol::{
    CiphertextMessageType, DeviceId, IdentityKey, IdentityKeyPair, InMemSignalProtocolStore, PreKeyBundle, PrivateKey,
    ProtocolAddress, PublicKey, SessionStore, kem, message_encrypt, process_prekey_bundle,
};
use rand::TryRngCore;
use rand::rngs::OsRng;
use wasm_bindgen::prelude::*;

use crate::js_error;

/// The current time. In the browser it comes from JavaScript: `SystemTime::now` has no clock on wasm32.
fn now() -> SystemTime {
    #[cfg(target_arch = "wasm32")]
    return SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(js_sys::Date::now() as u64);
    #[cfg(not(target_arch = "wasm32"))]
    return SystemTime::now();
}

/// Runs one of libsignal's async operations over the in-memory store, which never has to wait.
fn at_once<T>(future: impl Future<Output = T>) -> T {
    future.now_or_never().expect("the in-memory store answers at once")
}

fn device(id: u32) -> Result<DeviceId, JsError> {
    DeviceId::try_from(id).map_err(js_error)
}

/// One encrypted message for one device, as the server's message list takes it.
#[wasm_bindgen]
pub struct EncryptedForDevice {
    /// The envelope type: 1 for a message in an established session, 3 for one that also establishes it.
    #[wasm_bindgen(js_name = envelopeType)]
    pub envelope_type: u8,
    /// The device's registration ID, which the server checks against the device it delivers to.
    #[wasm_bindgen(js_name = registrationId)]
    pub registration_id: u32,
    body: Vec<u8>,
}

#[wasm_bindgen]
impl EncryptedForDevice {
    #[wasm_bindgen(getter)]
    pub fn body(&self) -> Vec<u8> {
        self.body.clone()
    }
}

#[wasm_bindgen]
pub struct OwnDeviceSessions {
    store: InMemSignalProtocolStore,
    aci: String,
    local: ProtocolAddress,
}

#[wasm_bindgen]
impl OwnDeviceSessions {
    /// The linked device's sessions: its identity key pair (the account's), its registration ID, the account's ACI
    /// and its device ID.
    #[wasm_bindgen(constructor)]
    pub fn new(
        identity_public: &[u8],
        identity_private: &[u8],
        registration_id: u32,
        aci: String,
        device_id: u32,
    ) -> Result<OwnDeviceSessions, JsError> {
        let identity = IdentityKeyPair::new(
            IdentityKey::decode(identity_public).map_err(js_error)?,
            PrivateKey::deserialize(identity_private).map_err(js_error)?,
        );
        let store = InMemSignalProtocolStore::new(identity, registration_id).map_err(js_error)?;
        let local = ProtocolAddress::new(aci.clone(), device(device_id)?);
        Ok(Self { store, aci, local })
    }

    fn address(&self, device_id: u32) -> Result<ProtocolAddress, JsError> {
        Ok(ProtocolAddress::new(self.aci.clone(), device(device_id)?))
    }

    #[wasm_bindgen(js_name = hasSession)]
    pub fn has_session(&self, device_id: u32) -> Result<bool, JsError> {
        let address = self.address(device_id)?;
        Ok(at_once(self.store.session_store.load_session(&address))
            .map_err(js_error)?
            .is_some())
    }

    /// Starts a session with a device from its prekey bundle, replacing any earlier session with it. Keys are in
    /// libsignal's serialized form, as the server sends them.
    #[wasm_bindgen(js_name = startSession)]
    #[allow(clippy::too_many_arguments)]
    pub fn start_session(
        &mut self,
        device_id: u32,
        registration_id: u32,
        identity_key: &[u8],
        signed_pre_key_id: u32,
        signed_pre_key: &[u8],
        signed_pre_key_signature: &[u8],
        kyber_pre_key_id: u32,
        kyber_pre_key: &[u8],
        kyber_pre_key_signature: &[u8],
        pre_key_id: Option<u32>,
        pre_key: Option<Vec<u8>>,
    ) -> Result<(), JsError> {
        let pre_key = match (pre_key_id, pre_key) {
            (Some(id), Some(key)) => Some((id.into(), PublicKey::deserialize(&key).map_err(js_error)?)),
            _ => None,
        };
        let bundle = PreKeyBundle::new(
            registration_id,
            device(device_id)?,
            pre_key,
            signed_pre_key_id.into(),
            PublicKey::deserialize(signed_pre_key).map_err(js_error)?,
            signed_pre_key_signature.to_vec(),
            kyber_pre_key_id.into(),
            kem::PublicKey::deserialize(kyber_pre_key).map_err(js_error)?,
            kyber_pre_key_signature.to_vec(),
            IdentityKey::decode(identity_key).map_err(js_error)?,
        )
        .map_err(js_error)?;
        let address = self.address(device_id)?;
        let mut rng = OsRng.unwrap_err();
        at_once(process_prekey_bundle(
            &address,
            &self.local,
            &mut self.store.session_store,
            &mut self.store.identity_store,
            &bundle,
            now(),
            &mut rng,
        ))
        .map_err(js_error)
    }

    /// Encrypts `padded` (the serialized Content, padded) for a device with an established session.
    pub fn encrypt(&mut self, device_id: u32, padded: &[u8]) -> Result<EncryptedForDevice, JsError> {
        let address = self.address(device_id)?;
        let mut rng = OsRng.unwrap_err();
        let message = at_once(message_encrypt(
            padded,
            &address,
            &self.local,
            &mut self.store.session_store,
            &mut self.store.identity_store,
            now(),
            &mut rng,
        ))
        .map_err(js_error)?;
        let envelope_type = match message.message_type() {
            CiphertextMessageType::Whisper => 1,
            CiphertextMessageType::PreKey => 3,
            other => return Err(JsError::new(&format!("unexpected message type {other:?}"))),
        };
        let record = at_once(self.store.session_store.load_session(&address))
            .map_err(js_error)?
            .ok_or_else(|| JsError::new("the session was lost"))?;
        Ok(EncryptedForDevice {
            envelope_type,
            registration_id: record.remote_registration_id().map_err(js_error)?,
            body: message.serialize().to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use libsignal_protocol::{
        CiphertextMessage, GenericSignedPreKey, IdentityKeyStore, KeyPair, KyberPreKeyRecord, KyberPreKeyStore,
        PreKeyRecord, PreKeySignalMessage, PreKeyStore, SignalMessage, SignedPreKeyRecord, SignedPreKeyStore,
        Timestamp, message_decrypt,
    };

    use super::*;

    const ACI: &str = "simulated-account";

    /// The phone: the account's identity key, and the prekeys it published.
    struct Phone {
        store: InMemSignalProtocolStore,
        address: ProtocolAddress,
        bundle: (u32, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>),
    }

    fn phone(identity: &IdentityKeyPair) -> Phone {
        let mut rng = OsRng.unwrap_err();
        let mut store = InMemSignalProtocolStore::new(*identity, 4321).unwrap();
        let pre_key = KeyPair::generate(&mut rng);
        let signed = KeyPair::generate(&mut rng);
        let kyber = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
        let signed_signature = identity
            .private_key()
            .calculate_signature(&signed.public_key.serialize(), &mut rng)
            .unwrap();
        let kyber_signature = identity
            .private_key()
            .calculate_signature(&kyber.public_key.serialize(), &mut rng)
            .unwrap();
        at_once(store.save_pre_key(7.into(), &PreKeyRecord::new(7.into(), &pre_key))).unwrap();
        let signed_record =
            SignedPreKeyRecord::new(8.into(), Timestamp::from_epoch_millis(1), &signed, &signed_signature);
        at_once(store.save_signed_pre_key(8.into(), &signed_record)).unwrap();
        let kyber_record = KyberPreKeyRecord::new(9.into(), Timestamp::from_epoch_millis(1), &kyber, &kyber_signature);
        at_once(store.save_kyber_pre_key(9.into(), &kyber_record)).unwrap();
        assert!(signed_record.public_key().is_ok());
        Phone {
            store,
            address: ProtocolAddress::new(ACI.into(), DeviceId::new(1).unwrap()),
            bundle: (
                4321,
                signed.public_key.serialize().to_vec(),
                signed_signature.to_vec(),
                kyber.public_key.serialize().to_vec(),
                kyber_signature.to_vec(),
                pre_key.public_key.serialize().to_vec(),
                identity.identity_key().serialize().to_vec(),
            ),
        }
    }

    fn decrypt(phone: &mut Phone, from: &ProtocolAddress, message: &EncryptedForDevice) -> Vec<u8> {
        let ciphertext = match message.envelope_type {
            3 => {
                CiphertextMessage::PreKeySignalMessage(PreKeySignalMessage::try_from(message.body.as_slice()).unwrap())
            }
            1 => CiphertextMessage::SignalMessage(SignalMessage::try_from(message.body.as_slice()).unwrap()),
            other => panic!("envelope type {other}"),
        };
        let mut rng = OsRng.unwrap_err();
        let store = &mut phone.store;
        at_once(message_decrypt(
            &ciphertext,
            from,
            &phone.address,
            &mut store.session_store,
            &mut store.identity_store,
            &mut store.pre_key_store,
            &store.signed_pre_key_store,
            &mut store.kyber_pre_key_store,
            &mut rng,
        ))
        .unwrap()
    }

    // Detects: a session that the phone cannot accept (a bundle built from the wrong fields, a wrong envelope type
    // or registration ID), or later messages that do not decrypt in the same session.
    #[test]
    fn the_phone_decrypts_what_the_linked_device_sends() {
        let mut rng = OsRng.unwrap_err();
        let identity = IdentityKeyPair::generate(&mut rng);
        let mut phone = phone(&identity);
        let mut sessions = OwnDeviceSessions::new(
            &identity.identity_key().serialize(),
            &identity.private_key().serialize(),
            1234,
            ACI.into(),
            3,
        )
        .unwrap();
        let (registration_id, signed, signed_signature, kyber, kyber_signature, pre_key, identity_key) =
            phone.bundle.clone();
        sessions
            .start_session(
                1,
                registration_id,
                &identity_key,
                8,
                &signed,
                &signed_signature,
                9,
                &kyber,
                &kyber_signature,
                Some(7),
                Some(pre_key),
            )
            .unwrap();
        let ours = ProtocolAddress::new(ACI.into(), DeviceId::new(3).unwrap());

        let first = sessions.encrypt(1, b"install these packs").unwrap();
        assert_eq!((first.envelope_type, first.registration_id), (3, 4321));
        assert_eq!(decrypt(&mut phone, &ours, &first), b"install these packs");

        let second = sessions.encrypt(1, b"and fetch the storage").unwrap();
        assert_eq!(decrypt(&mut phone, &ours, &second), b"and fetch the storage");
        assert!(
            at_once(phone.store.identity_store.get_identity(&ours))
                .unwrap()
                .is_some()
        );
    }
}
