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

use std::collections::HashMap;
use std::future::Future;
use std::io::Write;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, watch};

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
/// Upper bound on concurrent outbound HEAD requests to Signal's CDN.
const MAX_CONCURRENT_CDN_CHECKS: usize = 32;

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

/// Upper bound on distinct client addresses tracked by [`AddressLimiter`] in memory.
const MAX_TRACKED_ADDRESSES: usize = 10_000;

/// Normalizes an IP address for rate-limiting and per-client quotas: IPv4-mapped IPv6 addresses become IPv4, and
/// non-loopback IPv6 addresses are masked to their `/64` prefix so rotating host identifiers within one allocation
/// shares a single bucket.
pub fn rate_limit_key(address: IpAddr) -> IpAddr {
    match address.to_canonical() {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) if v6.is_loopback() => IpAddr::V6(v6),
        IpAddr::V6(v6) => {
            let prefix = u128::from(v6) & !u128::from(u64::MAX);
            IpAddr::V6(Ipv6Addr::from(prefix))
        }
    }
}

/// A token bucket per client address (or IPv6 `/64`), kept in memory only and bounded in size.
pub struct AddressLimiter {
    capacity: f64,
    refill_per_second: f64,
    max_addresses: usize,
    buckets: HashMap<IpAddr, (f64, Instant)>,
}

impl AddressLimiter {
    pub fn new(capacity: u32, refill_every: Duration) -> Self {
        Self::with_max_addresses(capacity, refill_every, MAX_TRACKED_ADDRESSES)
    }

    pub fn with_max_addresses(capacity: u32, refill_every: Duration, max_addresses: usize) -> Self {
        Self {
            capacity: capacity.into(),
            refill_per_second: 1.0 / refill_every.as_secs_f64(),
            max_addresses: max_addresses.max(1),
            buckets: HashMap::new(),
        }
    }

    /// Number of addresses currently tracked in memory.
    pub fn tracked_addresses(&self) -> usize {
        self.buckets.len()
    }

    /// Drops buckets that have refilled to full capacity, and if still at the cap drops the least-recently-used entry.
    fn prune(&mut self, now: Instant) {
        self.buckets.retain(|_, (tokens, last)| {
            let refilled = *tokens + now.duration_since(*last).as_secs_f64() * self.refill_per_second;
            refilled < self.capacity
        });
        while self.buckets.len() >= self.max_addresses {
            let Some(&oldest) = self.buckets.iter().min_by_key(|(_, (_, last))| *last).map(|(ip, _)| ip) else {
                break;
            };
            self.buckets.remove(&oldest);
        }
    }

    /// Takes one token for `address`; false when its bucket is empty.
    pub fn allow(&mut self, address: IpAddr, now: Instant) -> bool {
        let key = rate_limit_key(address);
        if !self.buckets.contains_key(&key) && self.buckets.len() >= self.max_addresses {
            self.prune(now);
        }
        let (tokens, last) = self.buckets.entry(key).or_insert((self.capacity, now));
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

fn split_entry(entry: &[u8; ENTRY_LEN]) -> ([u8; LOOKUP_KEY_LEN], [u8; PACK_ID_LEN]) {
    let lookup_key = entry[..LOOKUP_KEY_LEN]
        .try_into()
        .expect("an entry begins with a lookup key");
    let pack_id = entry[LOOKUP_KEY_LEN..].try_into().expect("an entry ends in a pack ID");
    (lookup_key, pack_id)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ListingStatus {
    New,
    ExactDuplicate,
    PackConflict,
}

fn listing_status(
    listed: &HashMap<[u8; PACK_ID_LEN], [u8; LOOKUP_KEY_LEN]>,
    lookup_key: &[u8; LOOKUP_KEY_LEN],
    pack_id: &[u8; PACK_ID_LEN],
) -> ListingStatus {
    match listed.get(pack_id) {
        None => ListingStatus::New,
        Some(existing) if existing == lookup_key => ListingStatus::ExactDuplicate,
        Some(_) => ListingStatus::PackConflict,
    }
}

type InFlightChecks = HashMap<[u8; PACK_ID_LEN], watch::Receiver<Option<OnSignal>>>;

struct IndexInner {
    /// Serializes disk appends and state updates inside `spawn_blocking` so client disconnects cannot diverge disk and memory.
    write_path: StdMutex<PathBuf>,
    entries: StdRwLock<Vec<[u8; ENTRY_LEN]>>,
    /// The Signal packs that have an entry (`pack_id -> lookup_key`).
    listed: StdRwLock<HashMap<[u8; PACK_ID_LEN], [u8; LOOKUP_KEY_LEN]>>,
    append_limiter: StdMutex<AddressLimiter>,
    signal_packs: SignalPacks,
    cdn_semaphore: Arc<Semaphore>,
    in_flight: Arc<AsyncMutex<InFlightChecks>>,
}

#[derive(Clone)]
pub struct Index(Arc<IndexInner>);

impl Index {
    /// Opens the index file, creating it if missing. Any trailing partial entry (from an interrupted write) is
    /// truncated back to an `ENTRY_LEN` boundary so subsequent appends stay aligned.
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
        let aligned_len = (entries.len() * ENTRY_LEN) as u64;
        if bytes.len() as u64 != aligned_len {
            let file = tokio::fs::OpenOptions::new().write(true).open(&path).await?;
            file.set_len(aligned_len).await?;
            file.sync_data().await?;
        }
        let mut listed = HashMap::with_capacity(entries.len());
        for entry in &entries {
            let (lookup_key, pack_id) = split_entry(entry);
            listed.entry(pack_id).or_insert(lookup_key);
        }
        Ok(Self(Arc::new(IndexInner {
            write_path: StdMutex::new(path),
            entries: StdRwLock::new(entries),
            listed: StdRwLock::new(listed),
            append_limiter: StdMutex::new(AddressLimiter::new(60, Duration::from_secs(60))),
            signal_packs,
            cdn_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_CDN_CHECKS)),
            in_flight: Arc::new(AsyncMutex::new(HashMap::new())),
        })))
    }

    /// Asks Signal's CDN whether `pack_id` exists, deduplicating concurrent checks for the same pack ID and bounding
    /// overall concurrency. Runs the outbound request in a detached task so a cancelled client cannot starve waiters.
    async fn check_signal_pack(&self, pack_id: [u8; PACK_ID_LEN]) -> OnSignal {
        let mut rx = {
            let mut in_flight = self.0.in_flight.lock().await;
            if let Some(existing) = in_flight.get(&pack_id) {
                existing.clone()
            } else {
                let (tx, rx) = watch::channel(None);
                in_flight.insert(pack_id, rx.clone());
                let semaphore = Arc::clone(&self.0.cdn_semaphore);
                let signal_packs = Arc::clone(&self.0.signal_packs);
                let map = Arc::clone(&self.0.in_flight);
                tokio::spawn(async move {
                    let answer = match semaphore.acquire_owned().await {
                        Ok(_permit) => signal_packs(pack_id).await,
                        Err(_) => OnSignal::Unknown,
                    };
                    let _ = tx.send(Some(answer));
                    map.lock().await.remove(&pack_id);
                });
                rx
            }
        };
        loop {
            if let Some(answer) = *rx.borrow() {
                return answer;
            }
            if rx.changed().await.is_err() {
                return OnSignal::Unknown;
            }
        }
    }
}

/// `GET /v1/sticker-packs/index?from=N`: entries from number N on, concatenated.
pub async fn read(State(index): State<Index>, Query(query): Query<HashMap<String, String>>) -> Response {
    let Ok(from) = query.get("from").map_or(Ok(0), |value| value.parse::<usize>()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let entries = index.0.entries.read().expect("entries lock not poisoned");
    let start = from.min(entries.len());
    let end = start.saturating_add(MAX_ENTRIES_PER_READ).min(entries.len());
    let body: Vec<u8> = entries[start..end].iter().flatten().copied().collect();
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
    let peer_ip = peer.ip().to_canonical();
    if !peer_ip.is_loopback() {
        return peer_ip;
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit(',').next())
        .and_then(|last| last.trim().parse::<IpAddr>().ok())
        .map(|ip| ip.to_canonical())
        .unwrap_or(peer_ip)
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
    let (lookup_key, pack_id) = split_entry(&entry);
    {
        let listed = index.0.listed.read().expect("listed lock not poisoned");
        match listing_status(&listed, &lookup_key, &pack_id) {
            ListingStatus::ExactDuplicate => return StatusCode::OK.into_response(),
            ListingStatus::PackConflict => return StatusCode::CONFLICT.into_response(),
            ListingStatus::New => {}
        }
    }
    if !index
        .0
        .append_limiter
        .lock()
        .expect("limiter lock not poisoned")
        .allow(client, Instant::now())
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    // Signal's CDN is asked without holding the write lock, deduplicated per pack ID and bounded in concurrency.
    match index.check_signal_pack(pack_id).await {
        OnSignal::Exists => {}
        OnSignal::Missing => return StatusCode::UNPROCESSABLE_ENTITY.into_response(),
        OnSignal::Unknown => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
    // Run the re-check, disk append + sync + rollback, and in-memory update inside `spawn_blocking` so cancelling
    // this HTTP handler future on client disconnect cannot leave disk and memory diverged or misaligned.
    let inner = Arc::clone(&index.0);
    let status = tokio::task::spawn_blocking(move || {
        let path = inner.write_path.lock().expect("write lock not poisoned");
        {
            let listed = inner.listed.read().expect("listed lock not poisoned");
            match listing_status(&listed, &lookup_key, &pack_id) {
                ListingStatus::ExactDuplicate => return StatusCode::OK,
                ListingStatus::PackConflict => return StatusCode::CONFLICT,
                ListingStatus::New => {}
            }
        }
        let aligned_len = (inner.entries.read().expect("entries lock not poisoned").len() * ENTRY_LEN) as u64;
        let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(&*path) {
            Ok(file) => file,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR,
        };
        if file.write_all(&entry).is_err() || file.sync_data().is_err() {
            // Roll back any partial write so the file remains aligned to ENTRY_LEN.
            let _ = file.set_len(aligned_len);
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
        inner
            .listed
            .write()
            .expect("listed lock not poisoned")
            .insert(pack_id, lookup_key);
        inner.entries.write().expect("entries lock not poisoned").push(entry);
        StatusCode::CREATED
    })
    .await
    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    status.into_response()
}
