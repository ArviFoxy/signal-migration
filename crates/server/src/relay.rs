//! WebSocket-to-TCP relay to an allow-list of Signal hosts.
//!
//! The page runs its own TLS session to the Signal host inside the WebSocket, pinned to Signal's root
//! certificate, so the relay carries only encrypted bytes. It does not log client addresses or traffic.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Signal host name → upstream address. Only these names can be tunnelled to.
#[derive(Clone)]
pub struct RelayTargets(pub Arc<HashMap<String, String>>);

impl RelayTargets {
    /// The Signal hosts the migration app needs, each reached on port 443.
    pub fn signal() -> Self {
        let hosts = [
            "chat.signal.org",
            "storage.signal.org",
            "cdn.signal.org",
            "cdn2.signal.org",
            "cdn3.signal.org",
        ];
        Self(Arc::new(
            hosts.iter().map(|h| (h.to_string(), format!("{h}:443"))).collect(),
        ))
    }
}

pub async fn tunnel(
    State(targets): State<RelayTargets>,
    Path(host): Path<String>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(upstream) = targets.0.get(&host).cloned() else {
        return StatusCode::FORBIDDEN.into_response();
    };
    upgrade.on_upgrade(move |socket| relay(socket, upstream))
}

/// Copies WebSocket binary frames to the TCP connection and TCP bytes back as binary frames,
/// until either side closes.
async fn relay(socket: WebSocket, upstream: String) {
    let Ok(tcp) = TcpStream::connect(upstream).await else {
        return;
    };
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_send, mut ws_receive) = socket.split();

    let to_upstream = async {
        while let Some(Ok(message)) = ws_receive.next().await {
            match message {
                Message::Binary(bytes) => {
                    if tcp_write.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        let _ = tcp_write.shutdown().await;
    };
    let to_client = async {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match tcp_read.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_send
                        .send(Message::Binary(bytes::Bytes::copy_from_slice(&buffer[..n])))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = ws_send.close().await;
    };
    tokio::select! {
        () = to_upstream => {}
        () = to_client => {}
    }
}
