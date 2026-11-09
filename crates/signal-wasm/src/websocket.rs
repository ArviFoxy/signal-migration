//! A WebSocket (tungstenite) inside a TLS session (rustls) to a Signal host, driven by bytes the page moves.
//!
//! The page can then send the handshake headers Signal requires, including Authorization, which the browser's
//! WebSocket API cannot set.

use std::io::ErrorKind;

use rustls::{ClientConnection, StreamOwned};
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::client::{ClientHandshake, generate_key};
use tungstenite::handshake::{HandshakeError, MidHandshake};
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message, WebSocket};
use wasm_bindgen::prelude::*;

use crate::js_error;
use crate::tls::{Transport, connect};

type TlsStream = StreamOwned<ClientConnection, Transport>;

enum State {
    Handshaking(MidHandshake<ClientHandshake<TlsStream>>),
    Open(WebSocket<TlsStream>),
    Closed,
}

#[wasm_bindgen]
pub struct TlsWebSocket {
    transport: Transport,
    state: State,
    messages: Vec<Vec<u8>>,
    close_code: Option<u16>,
}

fn is_would_block(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(io) if io.kind() == ErrorKind::WouldBlock)
}

#[wasm_bindgen]
impl TlsWebSocket {
    /// Starts TLS to `host` and the WebSocket upgrade of `path`, with extra handshake `headers` ("Name: value").
    #[wasm_bindgen(constructor)]
    pub fn new(host: &str, path: &str, headers: Vec<String>) -> Result<TlsWebSocket, JsError> {
        let transport = Transport::default();
        let stream = StreamOwned::new(connect(host).map_err(js_error)?, transport.clone());
        let mut request = format!("wss://{host}{path}").into_client_request().map_err(js_error)?;
        let fields = request.headers_mut();
        fields.insert("Sec-WebSocket-Key", generate_key().parse().map_err(js_error)?);
        for header in headers {
            let (name, value) = header.split_once(':').ok_or_else(|| JsError::new("a header must be \"Name: value\""))?;
            fields.insert(tungstenite::http::HeaderName::try_from(name.trim()).map_err(js_error)?, value.trim().parse().map_err(js_error)?);
        }
        let state = match tungstenite::client::client(request, stream) {
            Ok((socket, _)) => State::Open(socket),
            Err(HandshakeError::Interrupted(mid)) => State::Handshaking(mid),
            Err(HandshakeError::Failure(error)) => return Err(js_error(error)),
        };
        Ok(TlsWebSocket { transport, state, messages: Vec::new(), close_code: None })
    }

    /// Feeds ciphertext from the tunnel and advances the handshake and message reading.
    #[wasm_bindgen(js_name = receiveEncrypted)]
    pub fn receive_encrypted(&mut self, data: &[u8]) -> Result<(), JsError> {
        self.transport.push_received(data);
        self.drive()
    }

    /// Ciphertext waiting to go through the tunnel (possibly empty).
    #[wasm_bindgen(js_name = takeEncrypted)]
    pub fn take_encrypted(&mut self) -> Vec<u8> {
        self.transport.take_outgoing()
    }

    /// Binary messages received since the last call.
    #[wasm_bindgen(js_name = takeMessages)]
    pub fn take_messages(&mut self) -> js_sys::Array {
        std::mem::take(&mut self.messages).into_iter().map(|m| js_sys::Uint8Array::from(m.as_slice())).collect()
    }

    pub fn send(&mut self, data: &[u8]) -> Result<(), JsError> {
        match &mut self.state {
            State::Open(socket) => match socket.send(Message::Binary(data.to_vec().into())) {
                Ok(()) => Ok(()),
                Err(error) if is_would_block(&error) => Ok(()),
                Err(error) => Err(js_error(error)),
            },
            _ => Err(JsError::new("the WebSocket is not open")),
        }
    }

    pub fn close(&mut self, code: u16) {
        if let State::Open(socket) = &mut self.state {
            let _ = socket.close(Some(CloseFrame { code: CloseCode::from(code), reason: "".into() }));
            let _ = socket.flush();
        }
        self.state = State::Closed;
    }

    #[wasm_bindgen(getter, js_name = isOpen)]
    pub fn is_open(&self) -> bool {
        matches!(self.state, State::Open(_))
    }

    /// The close code the server sent, once the WebSocket has closed.
    #[wasm_bindgen(getter, js_name = closeCode)]
    pub fn close_code(&self) -> Option<u16> {
        self.close_code
    }

    fn drive(&mut self) -> Result<(), JsError> {
        loop {
            match std::mem::replace(&mut self.state, State::Closed) {
                State::Handshaking(mid) => match mid.handshake() {
                    Ok((socket, _)) => self.state = State::Open(socket),
                    Err(HandshakeError::Interrupted(mid)) => {
                        self.state = State::Handshaking(mid);
                        return Ok(());
                    }
                    Err(HandshakeError::Failure(error)) => return Err(js_error(error)),
                },
                State::Open(mut socket) => {
                    let result = loop {
                        match socket.read() {
                            Ok(Message::Binary(bytes)) => self.messages.push(bytes.to_vec()),
                            Ok(Message::Close(frame)) => {
                                self.close_code = Some(frame.map_or(1005, |f| f.code.into()));
                            }
                            Ok(_) => {}
                            Err(error) if is_would_block(&error) => break Ok(()),
                            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                                self.close_code.get_or_insert(1006);
                                break Ok(());
                            }
                            Err(error) => break Err(js_error(error)),
                        }
                    };
                    // Sends anything tungstenite queued while reading, such as pong replies.
                    match socket.flush() {
                        Ok(()) => {}
                        Err(error) if is_would_block(&error) => {}
                        Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {}
                        Err(error) => return Err(js_error(error)),
                    }
                    if self.close_code.is_none() {
                        self.state = State::Open(socket);
                    }
                    return result;
                }
                State::Closed => return Ok(()),
            }
        }
    }
}
