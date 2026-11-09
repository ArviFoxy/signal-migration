//! TLS to Signal hosts, trusting only Signal's own root certificates, over an in-memory transport.
//!
//! The page carries the encrypted bytes through a WebSocket tunnel to the relay, so the relay sees only ciphertext.
//! `Transport` is the in-memory socket: the page pushes received ciphertext in and takes ciphertext to send out.

use std::cell::RefCell;
use std::io::{ErrorKind, Read, Write};
use std::rc::Rc;
use std::sync::{Arc, OnceLock};

use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection, RootCertStore};

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
                roots
                    .add(CertificateDer::from(der))
                    .expect("libsignal's pinned roots parse");
            }
            let mut config = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("ring supports the default protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            // HTTP/1.1, the protocol of the WebSocket upgrade and of the storage service requests.
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        })
        .clone()
}

#[derive(Default)]
pub struct Buffers {
    pub incoming: Vec<u8>,
    pub outgoing: Vec<u8>,
}

/// An in-memory socket. Reading with nothing received yet reports `WouldBlock`, like a non-blocking socket.
#[derive(Clone, Default)]
pub struct Transport(pub Rc<RefCell<Buffers>>);

impl Read for Transport {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut buffers = self.0.borrow_mut();
        if buffers.incoming.is_empty() {
            return Err(ErrorKind::WouldBlock.into());
        }
        let n = buf.len().min(buffers.incoming.len());
        buf[..n].copy_from_slice(&buffers.incoming[..n]);
        buffers.incoming.drain(..n);
        Ok(n)
    }
}

impl Write for Transport {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().outgoing.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Transport {
    pub fn push_received(&self, data: &[u8]) {
        self.0.borrow_mut().incoming.extend_from_slice(data);
    }
    pub fn take_outgoing(&self) -> Vec<u8> {
        std::mem::take(&mut self.0.borrow_mut().outgoing)
    }
}

/// A TLS client connection to `host` with no limit on plaintext buffered before the handshake completes.
pub fn connect(host: &str) -> Result<ClientConnection, String> {
    let name = ServerName::try_from(host.to_owned()).map_err(|e| e.to_string())?;
    let mut connection = ClientConnection::new(config(), name).map_err(|e| e.to_string())?;
    connection.set_buffer_limit(None);
    Ok(connection)
}
