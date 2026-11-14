//! The sticker pack index: an append-only list of 48-byte entries, `lookup_key (32) || pack_id (16)`.
//!
//! Lookup keys are derived from a Telegram pack's content, so only someone who has the pack can compute one.
//! Clients download the whole list and match it locally; the server never learns which packs a user has.
//!
//! An entry is added only for a pack that Signal has, and a Signal pack is listed once. Every entry therefore costs
//! its sender an upload to Signal, and Signal limits how many packs an account uploads. The server asks Signal's
//! CDN whether the pack exists and reads nothing of it.
//! The server keeps no accounts and logs no client addresses; per-address limits live in memory only. Behind a reverse
//! proxy on the same machine, the limit counts the address the proxy reports (see `client_address`).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub const ENTRY_LEN: usize = 48;
pub const LOOKUP_KEY_LEN: usize = 32;
pub const PACK_ID_LEN: usize = ENTRY_LEN - LOOKUP_KEY_LEN;

/// What Signal's CDN says about a pack ID.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnSignal {
    Exists,
    Missing,
    /// The CDN gave no usable answer.
    Unknown,
}

/// Asks Signal's CDN whether it has a sticker pack with this ID.
pub type SignalPacks = Arc<dyn Fn([u8; PACK_ID_LEN]) -> Pin<Box<dyn Future<Output = OnSignal> + Send>> + Send + Sync>;

/// Signal's CDN under a publicly trusted certificate.
const PUBLIC_CDN: &str = "https://cdn-ca.signal.org";
/// How long Signal's CDN may take to answer.
const CDN_TIME_LIMIT: Duration = Duration::from_secs(10);

/// Asks Signal's CDN itself, with a request for the headers of the pack's manifest.
pub fn signal_cdn() -> SignalPacks {
    let client = reqwest::Client::builder()
        .timeout(CDN_TIME_LIMIT)
        .build()
        .expect("an HTTPS client without special settings can be built");
    Arc::new(move |pack_id| {
        let digits: String = pack_id.iter().map(|byte| format!("{byte:02x}")).collect();
        let request = client.head(format!("{PUBLIC_CDN}/stickers/{digits}/manifest.proto"));
        Box::pin(async move {
            match request.send().await.map(|response| response.status().as_u16()) {
                Ok(200) => OnSignal::Exists,
                // The CDN answers 403 for an object that its storage does not have.
                Ok(403 | 404) => OnSignal::Missing,
                _ => OnSignal::Unknown,
            }
        })
    })
}
/// At most this many entries per read; a client reads again from where the last read ended.
pub const MAX_ENTRIES_PER_READ: usize = 100_000;

/// A token bucket per client address, kept in memory only.
pub struct AddressLimiter {
    capacity: f64,
    refill_per_second: f64,
    buckets: HashMap<IpAddr, (f64, Instant)>,
}

impl AddressLimiter {
    pub fn new(capacity: u32, refill_every: Duration) -> Self {
        Self {
            capacity: capacity.into(),
            refill_per_second: 1.0 / refill_every.as_secs_f64(),
            buckets: HashMap::new(),
        }
    }

    /// Takes one token for `address`; false when its bucket is empty.
    pub fn allow(&mut self, address: IpAddr, now: Instant) -> bool {
        let (tokens, last) = self.buckets.entry(address).or_insert((self.capacity, now));
        *tokens = (*tokens + now.duration_since(*last).as_secs_f64() * self.refill_per_second).min(self.capacity);
        *last = now;
        if *tokens >= 1.0 {
            *tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

pub struct IndexState {
    path: PathBuf,
    entries: Vec<[u8; ENTRY_LEN]>,
    known: HashSet<[u8; ENTRY_LEN]>,
    /// The Signal packs that have an entry.
    listed: HashSet<[u8; PACK_ID_LEN]>,
    append_limiter: AddressLimiter,
    signal_packs: SignalPacks,
}

fn pack_id_of(entry: &[u8; ENTRY_LEN]) -> [u8; PACK_ID_LEN] {
    entry[LOOKUP_KEY_LEN..].try_into().expect("an entry ends in a pack ID")
}

#[derive(Clone)]
pub struct Index(pub Arc<Mutex<IndexState>>);

impl Index {
    /// Opens the index file, creating it if missing. A trailing partial entry (from an interrupted write) is ignored.
    /// `signal_packs` says whether Signal has a pack; [`signal_cdn`] asks Signal's CDN.
    pub async fn open(path: PathBuf, signal_packs: SignalPacks) -> std::io::Result<Self> {
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        let entries: Vec<[u8; ENTRY_LEN]> = bytes
            .chunks_exact(ENTRY_LEN)
            .map(|c| c.try_into().expect("exact chunk"))
            .collect();
        let known = entries.iter().copied().collect();
        let listed = entries.iter().map(pack_id_of).collect();
        Ok(Self(Arc::new(Mutex::new(IndexState {
            path,
            entries,
            known,
            listed,
            append_limiter: AddressLimiter::new(60, Duration::from_secs(60)),
            signal_packs,
        }))))
    }
}

/// `GET /v1/sticker-packs/index?from=N`: entries from number N on, concatenated.
pub async fn read(State(index): State<Index>, Query(query): Query<HashMap<String, String>>) -> Response {
    let Ok(from) = query.get("from").map_or(Ok(0), |value| value.parse::<usize>()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let state = index.0.lock().await;
    let start = from.min(state.entries.len());
    let end = (start + MAX_ENTRIES_PER_READ).min(state.entries.len());
    let body: Vec<u8> = state.entries[start..end].iter().flatten().copied().collect();
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

/// The address the per-address limit counts a request against.
///
/// A request whose connection comes from loopback came through a reverse proxy on the same machine, which puts the
/// client's address last in `X-Forwarded-For`. Any other request counts against its connection's own address, whatever
/// it sends in that header, so a client cannot choose its bucket. A loopback request without a readable header counts
/// against the loopback address.
pub fn client_address(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if !peer.ip().is_loopback() {
        return peer.ip();
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit(',').next())
        .and_then(|last| last.trim().parse().ok())
        .unwrap_or(peer.ip())
}

/// `POST /v1/sticker-packs/index` with one 48-byte entry: 201 when added, 200 when already present.
///
/// 409 when the Signal pack is listed for another Telegram pack, 422 when Signal has no such pack, and 503 when
/// Signal's CDN did not say.
pub async fn append(
    State(index): State<Index>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let client = client_address(peer, &headers);
    let Ok(entry) = <[u8; ENTRY_LEN]>::try_from(body.as_ref()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let pack_id = pack_id_of(&entry);
    let signal_packs = {
        let mut state = index.0.lock().await;
        if state.known.contains(&entry) {
            return StatusCode::OK.into_response();
        }
        if state.listed.contains(&pack_id) {
            return StatusCode::CONFLICT.into_response();
        }
        if !state.append_limiter.allow(client, Instant::now()) {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        state.signal_packs.clone()
    };
    // Signal's CDN is asked without the lock, so that a slow answer holds up nobody else.
    match signal_packs(pack_id).await {
        OnSignal::Exists => {}
        OnSignal::Missing => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        OnSignal::Unknown => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
    let mut state = index.0.lock().await;
    // Someone else may have added the same entry, or one for the same pack, while the CDN was asked.
    if state.known.contains(&entry) {
        return StatusCode::OK.into_response();
    }
    if state.listed.contains(&pack_id) {
        return StatusCode::CONFLICT.into_response();
    }
    let mut file = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.path)
        .await
    {
        Ok(file) => file,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if file.write_all(&entry).await.is_err() || file.sync_data().await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    state.entries.push(entry);
    state.known.insert(entry);
    state.listed.insert(pack_id);
    StatusCode::CREATED.into_response()
}
