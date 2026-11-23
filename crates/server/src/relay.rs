//! WebSocket-to-TCP relay to an allow-list of Signal hosts.
//!
//! The page runs its own TLS session to the Signal host inside the WebSocket, pinned to Signal's root
//! certificate, so the relay carries only encrypted bytes. It does not log client addresses or traffic.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::index::{client_address, rate_limit_key};

/// Signal host name → upstream address. Only these names can be tunnelled to.
#[derive(Clone)]
pub struct RelayTargets(pub Arc<HashMap<String, String>>);

/// Resource limits protecting the relay from connection, memory, and idle-socket exhaustion.
#[derive(Clone, Debug)]
pub struct RelayLimits {
    pub max_connections: usize,
    pub max_per_ip: usize,
    pub connect_timeout: Duration,
    pub idle_timeout: Duration,
    pub max_message_size: usize,
    pub max_frame_size: usize,
}

impl Default for RelayLimits {
    fn default() -> Self {
        Self {
            max_connections: 256,
            max_per_ip: 32,
            connect_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(5 * 60),
            max_message_size: 8 * 1024 * 1024,
            max_frame_size: 4 * 1024 * 1024,
        }
    }
}

/// Relay configuration and runtime concurrency accounting shared with `/tunnel/{host}`.
#[derive(Clone)]
pub struct RelayState {
    pub targets: RelayTargets,
    /// When non-empty, WebSocket upgrades must carry an `Origin` matching one of these origins (or same-origin when
    /// `allow_same_origin` is true).
    pub allowed_origins: Arc<Vec<HeaderValue>>,
    /// True when the server itself serves static frontend files; disabled in API-only mode.
    pub allow_same_origin: bool,
    pub limits: RelayLimits,
    global_slots: Arc<Semaphore>,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
}

impl RelayState {
    pub fn new(
        targets: RelayTargets,
        allowed_origins: Vec<HeaderValue>,
        allow_same_origin: bool,
        limits: RelayLimits,
    ) -> Self {
        let max_connections = limits.max_connections.max(1);
        Self {
            targets,
            allowed_origins: Arc::new(allowed_origins),
            allow_same_origin,
            limits,
            global_slots: Arc::new(Semaphore::new(max_connections)),
            per_ip: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn try_acquire(&self, client: IpAddr) -> Result<TunnelPermit, StatusCode> {
        let key = rate_limit_key(client);
        let global = self
            .global_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let mut counts = self.per_ip.lock().expect("per-IP relay lock not poisoned");
        let count = counts.entry(key).or_insert(0);
        if *count >= self.limits.max_per_ip.max(1) {
            if *count == 0 {
                counts.remove(&key);
            }
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        *count += 1;
        Ok(TunnelPermit {
            _global: global,
            per_ip: Arc::clone(&self.per_ip),
            key,
        })
    }
}

struct TunnelPermit {
    _global: OwnedSemaphorePermit,
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    key: IpAddr,
}

impl Drop for TunnelPermit {
    fn drop(&mut self) {
        let mut counts = self.per_ip.lock().expect("per-IP relay lock not poisoned");
        if let Some(count) = counts.get_mut(&self.key) {
            if *count <= 1 {
                counts.remove(&self.key);
            } else {
                *count -= 1;
            }
        }
    }
}

impl RelayTargets {
    /// The Signal hosts the migration app needs, each reached on port 443.
    pub fn signal() -> Self {
        let hosts = [
            "chat.signal.org",
            "storage.signal.org",
            "cdn.signal.org",
            "cdn2.signal.org",
            "cdn3.signal.org",
            // Contact discovery: finding the Signal accounts of phone numbers.
            "cdsi.signal.org",
        ];
        Self(Arc::new(
            hosts.iter().map(|h| (h.to_string(), format!("{h}:443"))).collect(),
        ))
    }
}

fn is_loopback_host(host_header: &str) -> bool {
    let host = if let Some(rest) = host_header.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host_header.split(':').next().unwrap_or("")
    };
    host.eq_ignore_ascii_case("localhost") || host.parse::<IpAddr>().is_ok_and(|ip| ip.to_canonical().is_loopback())
}

fn origin_allowed(headers: &HeaderMap, allowed_origins: &[HeaderValue], allow_same_origin: bool) -> bool {
    if allowed_origins.is_empty() {
        return true;
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return false;
    };
    if allowed_origins
        .iter()
        .any(|allowed| allowed.as_bytes().eq_ignore_ascii_case(origin.as_bytes()))
    {
        return true;
    }
    if !allow_same_origin {
        return false;
    }
    let Ok(origin_str) = origin.to_str() else {
        return false;
    };
    let (is_http, origin_host) = if let Some(host) = origin_str.strip_prefix("https://") {
        (false, host)
    } else if let Some(host) = origin_str.strip_prefix("http://") {
        (true, host)
    } else {
        return false;
    };
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host.eq_ignore_ascii_case(origin_host) && (!is_http || is_loopback_host(host)))
}

pub async fn tunnel(
    State(state): State<RelayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(host): Path<String>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers, &state.allowed_origins, state.allow_same_origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(upstream) = state.targets.0.get(&host).cloned() else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let client = client_address(peer, &headers);
    let permit = match state.try_acquire(client) {
        Ok(permit) => permit,
        Err(status) => return status.into_response(),
    };
    let limits = state.limits.clone();
    upgrade
        .max_message_size(limits.max_message_size)
        .max_frame_size(limits.max_frame_size)
        .on_upgrade(move |socket| relay(socket, upstream, limits, permit))
}

/// Copies WebSocket binary frames to the TCP connection and TCP bytes back as binary frames,
/// until either side closes or the tunnel stays idle longer than `limits.idle_timeout`.
async fn relay(socket: WebSocket, upstream: String, limits: RelayLimits, _permit: TunnelPermit) {
    let Ok(Ok(tcp)) = tokio::time::timeout(limits.connect_timeout, TcpStream::connect(upstream)).await else {
        return;
    };
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut ws_send, mut ws_receive) = socket.split();
    let mut buffer = vec![0u8; 16 * 1024];
    let idle = tokio::time::sleep(limits.idle_timeout);
    tokio::pin!(idle);

    loop {
        tokio::select! {
            () = &mut idle => {
                let _ = tcp_write.shutdown().await;
                let _ = ws_send.close().await;
                break;
            }
            ws_item = ws_receive.next() => {
                match ws_item {
                    Some(Ok(Message::Binary(bytes))) => {
                        idle.as_mut().reset(tokio::time::Instant::now() + limits.idle_timeout);
                        if !matches!(
                            tokio::time::timeout(limits.idle_timeout, tcp_write.write_all(&bytes)).await,
                            Ok(Ok(()))
                        ) {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {
                        idle.as_mut().reset(tokio::time::Instant::now() + limits.idle_timeout);
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        let _ = tcp_write.shutdown().await;
                        break;
                    }
                    Some(Ok(_)) => {}
                }
            }
            tcp_item = tcp_read.read(&mut buffer) => {
                match tcp_item {
                    Ok(0) | Err(_) => {
                        let _ = ws_send.close().await;
                        break;
                    }
                    Ok(n) => {
                        idle.as_mut().reset(tokio::time::Instant::now() + limits.idle_timeout);
                        let send = ws_send.send(Message::Binary(bytes::Bytes::copy_from_slice(&buffer[..n])));
                        if !matches!(tokio::time::timeout(limits.idle_timeout, send).await, Ok(Ok(()))) {
                            break;
                        }
                    }
                }
            }
        }
    }
}
