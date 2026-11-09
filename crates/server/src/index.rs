//! The sticker pack index: an append-only list of 48-byte entries, `lookup_key (32) || pack_id (16)`.
//!
//! Lookup keys are derived from a Telegram pack's content, so only someone who has the pack can compute one.
//! Clients download the whole list and match it locally; the server never learns which packs a user has.
//! The server keeps no accounts and logs no client addresses; per-address limits live in memory only.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub const ENTRY_LEN: usize = 48;
pub const LOOKUP_KEY_LEN: usize = 32;
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
    append_limiter: AddressLimiter,
}

#[derive(Clone)]
pub struct Index(pub Arc<Mutex<IndexState>>);

impl Index {
    /// Opens the index file, creating it if missing. A trailing partial entry (from an interrupted write) is ignored.
    pub async fn open(path: PathBuf) -> std::io::Result<Self> {
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
        Ok(Self(Arc::new(Mutex::new(IndexState {
            path,
            entries,
            known,
            append_limiter: AddressLimiter::new(60, Duration::from_secs(60)),
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

/// `POST /v1/sticker-packs/index` with one 48-byte entry: 201 when added, 200 when already present.
pub async fn append(
    State(index): State<Index>,
    ConnectInfo(client): ConnectInfo<std::net::SocketAddr>,
    body: Bytes,
) -> Response {
    let Ok(entry) = <[u8; ENTRY_LEN]>::try_from(body.as_ref()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let mut state = index.0.lock().await;
    if state.known.contains(&entry) {
        return StatusCode::OK.into_response();
    }
    if !state.append_limiter.allow(client.ip(), Instant::now()) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
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
    StatusCode::CREATED.into_response()
}
