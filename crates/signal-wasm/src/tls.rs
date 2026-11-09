//! A TLS client session to a Signal host that trusts only Signal's own root certificates.
//!
//! The page carries the encrypted side through a WebSocket tunnel to a relay, so the relay sees only
//! ciphertext. Bytes move in and out explicitly; this type does no I/O of its own.

use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, OnceLock};

use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use wasm_bindgen::prelude::*;

use crate::js_error;

/// The roots libsignal pins for every Signal service (`rust/net/src/certs.rs`).
const SIGNAL_ROOTS: [&[u8]; 2] = [
    include_bytes!("../../../third_party/libsignal/rust/net/res/signal.cer"),
    include_bytes!("../../../third_party/libsignal/rust/net/res/signal-ed25519.cer"),
];

fn config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            for der in SIGNAL_ROOTS {
                roots.add(CertificateDer::from(der)).expect("libsignal's pinned roots parse");
            }
            let mut config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("ring supports the default protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            // HTTP/1.1, because the page speaks HTTP/1.1 and the WebSocket upgrade itself.
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        })
        .clone()
}

#[wasm_bindgen]
pub struct TlsSession {
    connection: ClientConnection,
}

#[wasm_bindgen]
impl TlsSession {
    /// Starts a session to `host`; the first `takeEncrypted` returns the ClientHello.
    #[wasm_bindgen(constructor)]
    pub fn new(host: &str) -> Result<TlsSession, JsError> {
        let name = ServerName::try_from(host.to_owned()).map_err(js_error)?;
        Ok(TlsSession { connection: ClientConnection::new(config(), name).map_err(js_error)? })
    }

    /// Feeds encrypted bytes received from the tunnel. Fails if the server's certificate does not chain to
    /// Signal's roots or the connection is otherwise broken.
    #[wasm_bindgen(js_name = receiveEncrypted)]
    pub fn receive_encrypted(&mut self, mut data: &[u8]) -> Result<(), JsError> {
        while !data.is_empty() {
            self.connection.read_tls(&mut data).map_err(js_error)?;
            self.connection.process_new_packets().map_err(js_error)?;
        }
        Ok(())
    }

    /// Returns the decrypted bytes received so far (possibly none).
    #[wasm_bindgen(js_name = takePlaintext)]
    pub fn take_plaintext(&mut self) -> Result<Vec<u8>, JsError> {
        let mut plaintext = Vec::new();
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match self.connection.reader().read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => plaintext.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(js_error(error)),
            }
        }
        Ok(plaintext)
    }

    /// Queues plaintext to send; collect the result with `takeEncrypted`.
    #[wasm_bindgen(js_name = sendPlaintext)]
    pub fn send_plaintext(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.connection.writer().write_all(data).map_err(js_error)
    }

    /// Returns the encrypted bytes waiting to go through the tunnel (possibly none).
    #[wasm_bindgen(js_name = takeEncrypted)]
    pub fn take_encrypted(&mut self) -> Result<Vec<u8>, JsError> {
        let mut encrypted = Vec::new();
        while self.connection.wants_write() {
            self.connection.write_tls(&mut encrypted).map_err(js_error)?;
        }
        Ok(encrypted)
    }

    #[wasm_bindgen(getter, js_name = isHandshaking)]
    pub fn is_handshaking(&self) -> bool {
        self.connection.is_handshaking()
    }
}
