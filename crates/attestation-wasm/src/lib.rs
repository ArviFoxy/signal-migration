//! libsignal's check of an enclave's attestation, and the encrypted channel to the enclave that follows it.
//!
//! Signal's contact discovery runs inside an enclave: a protected part of a server that Signal's own operators cannot
//! look into. The enclave presents an attestation, a statement signed by the processor that names the exact code it
//! runs. A client checks the attestation before it sends phone numbers, and then talks to the enclave over a channel
//! that only that code can read. Both steps are libsignal's `attest` crate, unchanged; this crate only passes bytes
//! between it and the page.

use std::time::{Duration, SystemTime};

use wasm_bindgen::prelude::*;

mod contact_discovery;
#[cfg(target_arch = "wasm32")]
mod system_calls;

fn error(reason: impl std::fmt::Display) -> JsError {
    JsError::new(&reason.to_string())
}

fn time_from_unix_seconds(unix_seconds: f64) -> Result<SystemTime, JsError> {
    let duration = Duration::try_from_secs_f64(unix_seconds)
        .map_err(|_| error("the time of the check is not a valid time after 1970"))?;
    SystemTime::UNIX_EPOCH
        .checked_add(duration)
        .ok_or_else(|| error("the time of the check is out of range"))
}

/// The ID of the enclave code that Signal's contact discovery runs in production.
#[wasm_bindgen(js_name = contactDiscoveryEnclaveId)]
pub fn contact_discovery_enclave_id() -> Vec<u8> {
    attest::constants::ENCLAVE_ID_CDSI_PROD.to_vec()
}

/// The start of a channel to an enclave whose attestation passed the check.
#[wasm_bindgen]
pub struct EnclaveHandshake(attest::enclave::Handshake);

#[wasm_bindgen]
impl EnclaveHandshake {
    /// Checks the attestation that a contact discovery enclave sent, as of `unix_seconds`, and fails unless it is
    /// valid for the code `enclave_id` names.
    #[wasm_bindgen(js_name = forContactDiscovery)]
    pub fn for_contact_discovery(
        enclave_id: &[u8],
        attestation: &[u8],
        unix_seconds: f64,
    ) -> Result<EnclaveHandshake, JsError> {
        let now = time_from_unix_seconds(unix_seconds)?;
        attest::cds2::new_handshake(enclave_id, attestation, now)
            .map(EnclaveHandshake)
            .map_err(error)
    }

    /// The first message to send to the enclave.
    #[wasm_bindgen(js_name = initialRequest)]
    pub fn initial_request(&self) -> Vec<u8> {
        self.0.initial_request().to_vec()
    }

    /// Finishes the handshake with the enclave's answer to the first message.
    pub fn complete(self, answer: &[u8]) -> Result<EnclaveConnection, JsError> {
        self.0.complete(answer).map(EnclaveConnection).map_err(error)
    }
}

/// The encrypted channel to the enclave.
#[wasm_bindgen]
pub struct EnclaveConnection(attest::client_connection::ClientConnection);

#[wasm_bindgen]
impl EnclaveConnection {
    /// Encrypts a message for the enclave.
    pub fn send(&mut self, message: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.send(message).map_err(error)
    }

    /// Decrypts a message from the enclave.
    pub fn receive(&mut self, encrypted: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.recv(encrypted).map_err(error)
    }
}

#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn rejects_huge_and_invalid_unix_timestamps_without_panicking() {
        assert!(time_from_unix_seconds(1e30).is_err());
        assert!(time_from_unix_seconds(f64::NAN).is_err());
        assert!(time_from_unix_seconds(f64::INFINITY).is_err());
        assert!(time_from_unix_seconds(-1.0).is_err());
        assert!(time_from_unix_seconds(1_700_000_000.0).is_ok());
    }

    #[wasm_bindgen_test]
    fn wasi_shims_handle_null_and_zero_length_safely() {
        unsafe {
            assert_eq!(
                system_calls::__imported_wasi_snapshot_preview1_random_get(core::ptr::null_mut(), 0),
                0
            );
            assert_eq!(
                system_calls::__imported_wasi_snapshot_preview1_random_get(core::ptr::null_mut(), 4),
                28
            );
            assert_eq!(
                system_calls::__imported_wasi_snapshot_preview1_clock_time_get(0, 0, core::ptr::null_mut()),
                28
            );
            let mut written = 99usize;
            assert_eq!(
                system_calls::__imported_wasi_snapshot_preview1_fd_write(99, core::ptr::null(), 0, &mut written),
                8
            );
            assert_eq!(
                system_calls::__imported_wasi_snapshot_preview1_fd_write(2, core::ptr::null(), 0, &mut written),
                0
            );
            assert_eq!(written, 0);
        }
    }
}
