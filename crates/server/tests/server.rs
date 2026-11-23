//! Tests over real HTTP and WebSocket connections to a server on an ephemeral local port.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use signal_migration_server::index::{
    AddressLimiter, ENTRY_LEN, Index, OnSignal, SignalPacks, client_address, signal_cdn,
};
use signal_migration_server::relay::{RelayLimits, RelayTargets};
use signal_migration_server::{
    ClientConfig, Config, TelegramApp, parse_allowed_origins, parse_tls_config, router, router_with_relay_limits,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Stands in for Signal's CDN. It has every pack unless a test says otherwise for a pack ID, counts how often it is
/// asked, and answers only while `hold` is free.
#[derive(Clone, Default)]
struct FakeSignal {
    answers: Arc<Mutex<HashMap<[u8; 16], OnSignal>>>,
    asked: Arc<AtomicUsize>,
    hold: Arc<tokio::sync::RwLock<()>>,
}

impl FakeSignal {
    fn says(&self, pack_id: [u8; 16], answer: OnSignal) {
        self.answers.lock().unwrap().insert(pack_id, answer);
    }

    fn asked(&self) -> usize {
        self.asked.load(Ordering::SeqCst)
    }

    fn packs(&self) -> SignalPacks {
        let signal = self.clone();
        Arc::new(move |pack_id| {
            let signal = signal.clone();
            Box::pin(async move {
                signal.asked.fetch_add(1, Ordering::SeqCst);
                let _free = signal.hold.read().await;
                let answers = signal.answers.lock().unwrap();
                answers.get(&pack_id).copied().unwrap_or(OnSignal::Exists)
            })
        })
    }
}

struct TestServer {
    base: String,
    index_path: std::path::PathBuf,
    signal: FakeSignal,
    _dir: tempfile::TempDir,
}

impl TestServer {
    /// Sends an entry to the index and gives the status of the answer.
    async fn add(&self, entry: Vec<u8>) -> u16 {
        reqwest::Client::new()
            .post(format!("http://{}/v1/sticker-packs/index", self.base))
            .body(entry)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    async fn index(&self) -> Vec<u8> {
        reqwest::get(format!("http://{}/v1/sticker-packs/index", self.base))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap()
            .to_vec()
    }
}

async fn start(relay_targets: RelayTargets) -> TestServer {
    start_with_client_config(relay_targets, ClientConfig { telegram: None }).await
}

async fn start_with_client_config(relay_targets: RelayTargets, client: ClientConfig) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let index_path = dir.path().join("index.bin");
    let signal = FakeSignal::default();
    let config = Config {
        static_dir: Some(dir.path().to_path_buf()),
        frontend_redirect_url: None,
        allowed_origins: Vec::new(),
        index: Index::open(index_path.clone(), signal.packs()).await.unwrap(),
        relay_targets,
        client,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    TestServer {
        base: format!("127.0.0.1:{}", address.port()),
        index_path,
        signal,
        _dir: dir,
    }
}

/// A TCP server that sends back whatever it receives, standing in for a Signal host.
async fn echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 1024];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            if n == 0 {
                break;
            }
            stream.write_all(&buffer[..n]).await.unwrap();
        }
    });
    address
}

fn entry(seed: u8) -> Vec<u8> {
    vec![seed; ENTRY_LEN]
}

/// The entry that names the Signal pack `pack` as a copy of the Telegram pack `lookup`.
fn entry_for(lookup: u8, pack: u8) -> Vec<u8> {
    [[lookup; 32].as_slice(), &[pack; 16]].concat()
}

/// Detects: the relay dropping, reordering or altering bytes in either direction.
#[tokio::test]
async fn relay_carries_bytes_both_ways_to_an_allowed_host() {
    let echo = echo_server().await;
    let targets = RelayTargets(Arc::new(HashMap::from([(
        "chat.signal.org".to_string(),
        echo.to_string(),
    )])));
    let server = start(targets).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/tunnel/chat.signal.org", server.base))
        .await
        .unwrap();
    let payload: Vec<u8> = (0..=255).collect();
    socket.send(Message::Binary(payload.clone().into())).await.unwrap();
    let mut received = Vec::new();
    while received.len() < payload.len() {
        match socket.next().await.unwrap().unwrap() {
            Message::Binary(bytes) => received.extend_from_slice(&bytes),
            _ => {}
        }
    }
    assert_eq!(received, payload);
}

/// Detects: the relay acting as an open proxy to hosts outside the allow-list.
#[tokio::test]
async fn relay_refuses_a_host_outside_the_allow_list() {
    let server = start(RelayTargets::signal()).await;
    let result = tokio_tungstenite::connect_async(format!("ws://{}/tunnel/example.com", server.base)).await;
    match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => assert_eq!(response.status(), 403),
        other => panic!("expected an HTTP 403 refusal, got {other:?}"),
    }
}

/// Detects: an appended entry not being readable, or not surviving a restart.
#[tokio::test]
async fn appended_entry_is_read_back_and_persists_across_restart() {
    let server = start(RelayTargets::signal()).await;
    let client = reqwest::Client::new();
    let status = client
        .post(format!("http://{}/v1/sticker-packs/index", server.base))
        .body(entry(7))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 201);
    let body = client
        .get(format!("http://{}/v1/sticker-packs/index", server.base))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(body.as_ref(), entry(7).as_slice());

    let reopened = Index::open(server.index_path.clone(), server.signal.packs())
        .await
        .unwrap();
    let restarted = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = Config {
            static_dir: Some(std::env::temp_dir()),
            frontend_redirect_url: None,
            allowed_origins: Vec::new(),
            index: reopened,
            relay_targets: RelayTargets::signal(),
            client: ClientConfig { telegram: None },
        };
        tokio::spawn(async move {
            axum::serve(
                listener,
                router(config).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap()
        });
        address
    };
    let body = client
        .get(format!("http://{restarted}/v1/sticker-packs/index"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(body.as_ref(), entry(7).as_slice());
}

/// Detects: malformed entries entering the fixed-width index file and shifting every later entry.
#[tokio::test]
async fn entry_of_wrong_length_is_rejected() {
    let server = start(RelayTargets::signal()).await;
    let status = reqwest::Client::new()
        .post(format!("http://{}/v1/sticker-packs/index", server.base))
        .body(vec![1u8; ENTRY_LEN - 1])
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 400);
}

/// Detects: the same entry being stored twice when two uploaders race.
#[tokio::test]
async fn duplicate_entry_is_stored_once() {
    let server = start(RelayTargets::signal()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/sticker-packs/index", server.base);
    assert_eq!(client.post(&url).body(entry(3)).send().await.unwrap().status(), 201);
    assert_eq!(client.post(&url).body(entry(3)).send().await.unwrap().status(), 200);
    let body = client.get(&url).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(body.len(), ENTRY_LEN);
}

/// Detects: incremental reads returning entries the client already has, or missing new ones.
#[tokio::test]
async fn read_from_offset_returns_only_later_entries() {
    let server = start(RelayTargets::signal()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/sticker-packs/index", server.base);
    for seed in 1..=3 {
        client.post(&url).body(entry(seed)).send().await.unwrap();
    }
    let body = client
        .get(format!("{url}?from=2"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(body.as_ref(), entry(3).as_slice());
}

/// Detects: the per-address limit never refusing, or never letting a client back in after waiting.
#[test]
fn address_limiter_refuses_when_empty_and_refills_over_time() {
    let mut limiter = AddressLimiter::new(2, Duration::from_secs(10));
    let address = "192.0.2.1".parse().unwrap();
    let start = Instant::now();
    assert!(limiter.allow(address, start));
    assert!(limiter.allow(address, start));
    assert!(!limiter.allow(address, start));
    assert!(limiter.allow(address, start + Duration::from_secs(10)));
    assert!(!limiter.allow(address, start + Duration::from_secs(10)));
}

/// Detects: behind the local reverse proxy, every client sharing the proxy's address, or the wrong entry of
/// `X-Forwarded-For` being used; anywhere else, a client choosing its own limit by sending the header.
#[test]
fn client_address_trusts_forwarded_for_only_from_loopback() {
    let headers = |values: &[&str]| {
        let mut map = axum::http::HeaderMap::new();
        for value in values {
            map.append("x-forwarded-for", value.parse().unwrap());
        }
        map
    };
    let proxy: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let proxy_v6: SocketAddr = "[::1]:50000".parse().unwrap();
    let direct: SocketAddr = "198.51.100.7:50000".parse().unwrap();
    let ip = |text: &str| text.parse::<std::net::IpAddr>().unwrap();

    assert_eq!(client_address(proxy, &headers(&["203.0.113.5"])), ip("203.0.113.5"));
    assert_eq!(client_address(proxy_v6, &headers(&["2001:db8::5"])), ip("2001:db8::5"));
    // The proxy adds the client last; earlier entries come from the client and are not trusted.
    assert_eq!(
        client_address(proxy, &headers(&["192.0.2.1, 203.0.113.5"])),
        ip("203.0.113.5")
    );
    assert_eq!(
        client_address(proxy, &headers(&["192.0.2.1", "203.0.113.5"])),
        ip("203.0.113.5")
    );
    assert_eq!(client_address(proxy, &headers(&[])), ip("127.0.0.1"));
    assert_eq!(client_address(proxy, &headers(&["not an address"])), ip("127.0.0.1"));
    assert_eq!(client_address(direct, &headers(&["203.0.113.5"])), ip("198.51.100.7"));
}

/// Detects: the index's append limit not following the address the proxy reports, so that one client behind the
/// proxy uses up the limit for everyone.
#[tokio::test]
async fn clients_behind_the_proxy_have_separate_limits() {
    let server = start(RelayTargets::signal()).await;
    let client = reqwest::Client::new();
    let post = |seed: u8, forwarded_for: &'static str| {
        client
            .post(format!("http://{}/v1/sticker-packs/index", server.base))
            .header("x-forwarded-for", forwarded_for)
            .body(entry(seed))
            .send()
    };
    for seed in 0..60 {
        assert_eq!(post(seed, "203.0.113.5").await.unwrap().status(), 201);
    }
    assert_eq!(post(60, "203.0.113.5").await.unwrap().status(), 429);
    assert_eq!(post(61, "203.0.113.6").await.unwrap().status(), 201);
}

/// Detects: the page not receiving the Telegram app identity it needs to start TDLib, or receiving it under other names.
#[tokio::test]
async fn config_carries_the_telegram_app_identity() {
    let client = ClientConfig {
        telegram: Some(TelegramApp {
            api_id: 12345,
            api_hash: "0123456789abcdef".into(),
            test_dc: false,
        }),
    };
    let server = start_with_client_config(RelayTargets::signal(), client).await;
    let body = reqwest::Client::new()
        .get(format!("http://{}/v1/config", server.base))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(
        body,
        r#"{"telegram":{"apiId":12345,"apiHash":"0123456789abcdef","testDc":false}}"#
    );
}

/// Detects: browsers downloading the uncompressed WebAssembly (15 MB for TDLib) although a compressed copy exists, or
/// the compressed copy arriving with a type under which the browser cannot start WebAssembly.
#[tokio::test]
async fn compressed_copy_is_sent_to_a_browser_that_accepts_it() {
    let server = start(RelayTargets::signal()).await;
    let static_dir = server.index_path.parent().unwrap();
    std::fs::write(static_dir.join("module.wasm"), b"plain").unwrap();
    std::fs::write(static_dir.join("module.wasm.br"), b"brotli").unwrap();
    let client = reqwest::Client::new();
    let url = format!("http://{}/module.wasm", server.base);
    let response = client
        .get(&url)
        .header("Accept-Encoding", "br, gzip")
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["content-encoding"], "br");
    assert_eq!(response.headers()["content-type"], "application/wasm");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"brotli");
    let plain = client.get(&url).send().await.unwrap();
    assert!(plain.headers().get("content-encoding").is_none());
    assert_eq!(plain.bytes().await.unwrap().as_ref(), b"plain");
}

/// Detects: unhashed app bundles or WASM modules being heuristically cached across deploys, or hashed fonts not
/// being marked immutable.
#[tokio::test]
async fn static_assets_carry_appropriate_cache_control() {
    let server = start(RelayTargets::signal()).await;
    let static_dir = server.index_path.parent().unwrap();
    std::fs::write(static_dir.join("main.js"), b"console.log(1)").unwrap();
    std::fs::create_dir_all(static_dir.join("fonts")).unwrap();
    std::fs::write(static_dir.join("fonts/inter-abc123.woff2"), b"font").unwrap();
    let client = reqwest::Client::new();

    let js = client
        .get(format!("http://{}/main.js", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(js.headers()["cache-control"], "no-cache");

    let font = client
        .get(format!("http://{}/fonts/inter-abc123.woff2", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(font.headers()["cache-control"], "public, max-age=31536000, immutable");
}

/// Detects: a trailing partial write leaving the index file misaligned so later appends corrupt every entry after it.
#[tokio::test]
async fn trailing_partial_entry_is_truncated_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("index.bin");
    let first = entry_for(1, 1);
    let second = entry_for(2, 2);
    let mut corrupted = first.to_vec();
    corrupted.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef, 0x11]); // 5-byte trailing partial write
    std::fs::write(&path, &corrupted).unwrap();

    let signal = FakeSignal::default();
    let index = Index::open(path.clone(), signal.packs()).await.unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().len() as usize, ENTRY_LEN);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    let config = Config {
        static_dir: Some(dir.path().to_path_buf()),
        frontend_redirect_url: None,
        allowed_origins: Vec::new(),
        index,
        relay_targets: RelayTargets::signal(),
        client: ClientConfig { telegram: None },
    };
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let server = TestServer {
        base,
        index_path: path.clone(),
        signal: signal.clone(),
        _dir: dir,
    };
    assert_eq!(server.add(second.clone()).await, 201);
    assert_eq!(std::fs::metadata(&path).unwrap().len() as usize, 2 * ENTRY_LEN);
    // Reopen to confirm the second entry reads cleanly at the aligned 48-byte offset.
    let reopened = Index::open(path, signal.packs()).await.unwrap();
    let mut expected = first.to_vec();
    expected.extend_from_slice(&second);
    let listener2 = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base2 = listener2.local_addr().unwrap().to_string();
    let config2 = Config {
        static_dir: Some(std::env::temp_dir()),
        frontend_redirect_url: None,
        allowed_origins: Vec::new(),
        index: reopened,
        relay_targets: RelayTargets::signal(),
        client: ClientConfig { telegram: None },
    };
    tokio::spawn(async move {
        axum::serve(
            listener2,
            router(config2).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let bytes = reqwest::Client::new()
        .get(format!("http://{base2}/v1/sticker-packs/index?from=0"))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(bytes.as_ref(), expected.as_slice());
}

/// Detects: unbounded memory growth in AddressLimiter when many unique client IPs make requests over time.
#[test]
fn address_limiter_prunes_refilled_buckets_and_bounds_memory() {
    let mut limiter = AddressLimiter::with_max_addresses(2, Duration::from_secs(1), 4);
    let t0 = Instant::now();
    for i in 1..=4u8 {
        assert!(limiter.allow(std::net::IpAddr::from([10, 0, 0, i]), t0));
    }
    assert_eq!(limiter.tracked_addresses(), 4);
    // After full refill, a new address prunes the refilled buckets.
    let t1 = t0 + Duration::from_secs(5);
    assert!(limiter.allow(std::net::IpAddr::from([10, 0, 0, 99]), t1));
    assert_eq!(limiter.tracked_addresses(), 1);
    // Even without waiting for refill, distinct addresses never exceed max_addresses.
    for i in 10..30u8 {
        assert!(limiter.allow(std::net::IpAddr::from([10, 0, 1, i]), t1));
    }
    assert!(limiter.tracked_addresses() <= 4);
}

/// Detects: entries for packs that nobody uploaded. Without this rule anyone fills the index for free, and every
/// browser asks Signal about each made-up pack.
#[tokio::test]
async fn an_entry_for_a_pack_that_signal_does_not_have_is_refused() {
    let server = start(RelayTargets::signal()).await;
    server.signal.says([9; 16], OnSignal::Missing);
    assert_eq!(server.add(entry_for(1, 9)).await, 422);
    assert_eq!(server.index().await, b"");
    server.signal.says([9; 16], OnSignal::Exists);
    assert_eq!(server.add(entry_for(1, 9)).await, 201, "once Signal has the pack");
}

/// Detects: one upload listed under many Telegram packs, which would make an entry cost nothing again; the rule
/// forgotten after a restart.
#[tokio::test]
async fn a_signal_pack_is_listed_once() {
    let server = start(RelayTargets::signal()).await;
    assert_eq!(server.add(entry_for(1, 9)).await, 201);
    assert_eq!(server.add(entry_for(2, 9)).await, 409);
    assert_eq!(
        server.add(entry_for(1, 9)).await,
        200,
        "the same entry again changes nothing"
    );
    assert_eq!(server.index().await, entry_for(1, 9));

    let reopened = Index::open(server.index_path.clone(), server.signal.packs())
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let restarted = TestServer {
        base: listener.local_addr().unwrap().to_string(),
        index_path: server.index_path.clone(),
        signal: server.signal.clone(),
        _dir: tempfile::tempdir().unwrap(),
    };
    let config = Config {
        static_dir: Some(std::env::temp_dir()),
        frontend_redirect_url: None,
        allowed_origins: Vec::new(),
        index: reopened,
        relay_targets: RelayTargets::signal(),
        client: ClientConfig { telegram: None },
    };
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap()
    });
    assert_eq!(restarted.add(entry_for(2, 9)).await, 409);
    assert_eq!(restarted.add(entry_for(2, 8)).await, 201);
}

/// Detects: an entry added although Signal's CDN did not say that the pack exists.
#[tokio::test]
async fn nothing_is_added_while_signals_cdn_gives_no_answer() {
    let server = start(RelayTargets::signal()).await;
    server.signal.says([9; 16], OnSignal::Unknown);
    assert_eq!(server.add(entry_for(1, 9)).await, 503);
    assert_eq!(server.index().await, b"");
}

/// Detects: the server asking Signal's CDN for requests that it answers by itself, which would let anyone make it
/// send requests to Signal without limit: an entry it already has, a pack it already lists, and a client over the
/// limit per address.
#[tokio::test]
async fn signals_cdn_is_asked_only_for_an_entry_that_could_be_added() {
    let server = start(RelayTargets::signal()).await;
    assert_eq!(server.add(entry_for(1, 9)).await, 201);
    assert_eq!(server.signal.asked(), 1);
    assert_eq!(server.add(entry_for(1, 9)).await, 200);
    assert_eq!(server.add(entry_for(2, 9)).await, 409);
    assert_eq!(server.add(vec![1; 47]).await, 400);
    assert_eq!(server.signal.asked(), 1);

    // The limit per address is 60 entries at once.
    let mut refused = 0;
    for pack in 100..170u8 {
        if server.add(entry_for(pack, pack)).await == 429 {
            refused += 1;
        }
    }
    assert_eq!(refused, 11, "70 more entries after the first one");
    assert_eq!(server.signal.asked(), 60);
}

/// Detects: two entries for one Signal pack both added when they arrive together, and duplicate outbound CDN checks
/// for the same in-flight pack ID.
#[tokio::test]
async fn two_entries_for_one_pack_that_arrive_together_give_one_entry() {
    let server = Arc::new(start(RelayTargets::signal()).await);
    let held = server.signal.hold.clone().write_owned().await;
    let first = tokio::spawn({
        let server = server.clone();
        async move { server.add(entry_for(1, 9)).await }
    });
    while server.signal.asked() < 1 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let second = tokio::spawn({
        let server = server.clone();
        async move { server.add(entry_for(2, 9)).await }
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    // Concurrent checks for the same pack ID are deduplicated to one outbound CDN HEAD request.
    assert_eq!(server.signal.asked(), 1);
    drop(held);
    let mut answers = [first.await.unwrap(), second.await.unwrap()];
    answers.sort();
    assert_eq!(answers, [201, 409]);
    assert_eq!(server.index().await.len(), ENTRY_LEN);
}

/// Detects: CORS misconfiguration blocking GitHub Pages from reading `/v1/config` or reading/appending
/// `/v1/sticker-packs/index`, or leaking CORS access to unlisted origins.
#[tokio::test]
async fn cors_allows_configured_origins_on_api_routes_only() {
    let dir = tempfile::tempdir().unwrap();
    let signal = FakeSignal::default();
    let allowed = parse_allowed_origins("https://arvifoxy.github.io, https://signal-migration.github.io").unwrap();
    let config = Config {
        static_dir: None,
        frontend_redirect_url: Some("https://arvifoxy.github.io/signal-migration/".to_string()),
        allowed_origins: allowed,
        index: Index::open(dir.path().join("index.bin"), signal.packs()).await.unwrap(),
        relay_targets: RelayTargets::signal(),
        client: ClientConfig { telegram: None },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    // Allowed origin receives CORS headers on GET /v1/config and OPTIONS preflight for POST /v1/sticker-packs/index.
    let response = client
        .get(format!("http://{base}/v1/config"))
        .header("Origin", "https://arvifoxy.github.io")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("https://arvifoxy.github.io")
    );

    let preflight = client
        .request(
            reqwest::Method::OPTIONS,
            format!("http://{base}/v1/sticker-packs/index"),
        )
        .header("Origin", "https://signal-migration.github.io")
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "content-type")
        .send()
        .await
        .unwrap();
    assert!(preflight.status().is_success());
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("https://signal-migration.github.io")
    );

    // Unlisted origin does not get Access-Control-Allow-Origin.
    let foreign = client
        .get(format!("http://{base}/v1/config"))
        .header("Origin", "https://evil.example")
        .send()
        .await
        .unwrap();
    assert!(foreign.headers().get("access-control-allow-origin").is_none());

    // When STATIC_DIR is omitted and FRONTEND_REDIRECT_URL is set, GET / redirects to the frontend.
    let root = client.get(format!("http://{base}/")).send().await.unwrap();
    assert_eq!(root.status(), 307);
    assert_eq!(
        root.headers().get("location").and_then(|v| v.to_str().ok()),
        Some("https://arvifoxy.github.io/signal-migration/")
    );
}

/// Detects: the WebSocket relay allowing third-party origins when `ALLOWED_ORIGINS` is configured, or rejecting the
/// configured frontend origin or a same-origin page.
#[tokio::test]
async fn relay_enforces_allowed_origins_when_configured() {
    let echo = echo_server().await;
    let dir = tempfile::tempdir().unwrap();
    let signal = FakeSignal::default();
    let targets = RelayTargets(Arc::new(HashMap::from([(
        "chat.signal.org".to_string(),
        echo.to_string(),
    )])));
    let config = Config {
        static_dir: None,
        frontend_redirect_url: None,
        allowed_origins: parse_allowed_origins("https://arvifoxy.github.io").unwrap(),
        index: Index::open(dir.path().join("index.bin"), signal.packs()).await.unwrap(),
        relay_targets: targets,
        client: ClientConfig { telegram: None },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Missing Origin is rejected.
    let missing = tokio_tungstenite::connect_async(format!("ws://{base}/tunnel/chat.signal.org")).await;
    assert!(missing.is_err(), "missing Origin must be rejected");

    // Unlisted Origin is rejected.
    let mut bad_req = format!("ws://{base}/tunnel/chat.signal.org")
        .into_client_request()
        .unwrap();
    bad_req
        .headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    let bad = tokio_tungstenite::connect_async(bad_req).await;
    assert!(bad.is_err(), "unlisted Origin must be rejected");

    // Configured Origin is accepted.
    let mut good_req = format!("ws://{base}/tunnel/chat.signal.org")
        .into_client_request()
        .unwrap();
    good_req
        .headers_mut()
        .insert("Origin", "https://arvifoxy.github.io".parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(good_req).await.unwrap();
    socket.send(Message::Binary(b"ping".to_vec().into())).await.unwrap();
    let reply = socket.next().await.unwrap().unwrap();
    assert_eq!(reply, Message::Binary(b"ping".to_vec().into()));
    let _ = socket.close(None).await;

    // API-only server does not fall back to Origin == Host.
    let mut same_req = format!("ws://{base}/tunnel/chat.signal.org")
        .into_client_request()
        .unwrap();
    same_req
        .headers_mut()
        .insert("Origin", format!("http://{base}").parse().unwrap());
    assert!(
        tokio_tungstenite::connect_async(same_req).await.is_err(),
        "API-only server must reject Host-fallback Origin"
    );

    // API-only server without redirect returns 404 on /.
    let root = reqwest::get(format!("http://{base}/")).await.unwrap();
    assert_eq!(root.status(), 404);
}

/// Detects: invalid ALLOWED_ORIGINS entries (paths, trailing slashes, non-HTTP schemes) silently accepted.
#[test]
fn parse_allowed_origins_rejects_paths_and_non_http_schemes() {
    assert!(parse_allowed_origins("https://arvifoxy.github.io/signal-migration").is_err());
    assert!(parse_allowed_origins("https://arvifoxy.github.io/").is_err());
    assert!(parse_allowed_origins("ftp://arvifoxy.github.io").is_err());
    let parsed = parse_allowed_origins(" https://arvifoxy.github.io , http://127.0.0.1:8080 ").unwrap();
    assert_eq!(parsed.len(), 2);
}

/// Detects: uppercase hostnames, comma-only values failing open, or userinfo/whitespace slipping through ALLOWED_ORIGINS.
#[test]
fn parse_allowed_origins_normalizes_case_and_rejects_empty_commas_and_userinfo() {
    assert!(parse_allowed_origins(",").is_err());
    assert!(parse_allowed_origins(" , , ").is_err());
    assert!(parse_allowed_origins("https://user@127.0.0.1").is_err());
    assert!(parse_allowed_origins("https://example.com evil").is_err());
    assert!(parse_allowed_origins("http:example.com").is_err());
    assert!(parse_allowed_origins("http:").is_err());
    let parsed = parse_allowed_origins("https://ArviFoxy.github.io").unwrap();
    assert_eq!(
        parsed,
        vec![axum::http::HeaderValue::from_static("https://arvifoxy.github.io")]
    );
}

/// Detects: rotating addresses within a single IPv6 /64 bypassing per-address rate limiting.
#[test]
fn ipv6_addresses_in_same_64_share_rate_limit() {
    let mut limiter = AddressLimiter::new(2, Duration::from_secs(60));
    let start = Instant::now();
    assert!(limiter.allow("2001:db8:1:2::1".parse().unwrap(), start));
    assert!(limiter.allow("2001:db8:1:2::2".parse().unwrap(), start));
    assert!(!limiter.allow("2001:db8:1:2::3".parse().unwrap(), start));
    assert!(limiter.allow("2001:db8:1:3::1".parse().unwrap(), start));
}

/// Detects: dual-stack IPv4-mapped IPv6 loopback ignoring X-Forwarded-For behind a local reverse proxy.
#[test]
fn client_address_recognizes_ipv4_mapped_ipv6_loopback() {
    let mut headers = axum::http::HeaderMap::new();
    headers.append("x-forwarded-for", "203.0.113.5".parse().unwrap());
    let mapped_loopback: SocketAddr = "[::ffff:127.0.0.1]:50000".parse().unwrap();
    assert_eq!(
        client_address(mapped_loopback, &headers),
        "203.0.113.5".parse::<std::net::IpAddr>().unwrap()
    );
}

/// Detects: 404/error responses under /fonts/ being permanently marked immutable.
#[tokio::test]
async fn missing_font_is_not_cached_immutable() {
    let server = start(RelayTargets::signal()).await;
    let response = reqwest::get(format!("http://{}/fonts/missing.woff2", server.base))
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    assert_eq!(response.headers()["cache-control"], "no-cache");
}

/// Detects: POST /v1/sticker-packs/index buffering megabytes before checking the 48-byte entry length.
#[tokio::test]
async fn oversized_index_post_is_rejected_with_413() {
    let server = start(RelayTargets::signal()).await;
    let status = server.add(vec![0u8; 64 * 1024]).await;
    assert_eq!(status, 413);
}

/// Detects: API-only relay accepting an http:// origin matching Host (scheme downgrade / unintended Host fallback).
#[tokio::test]
async fn api_only_relay_rejects_host_origin_fallback() {
    let echo = echo_server().await;
    let dir = tempfile::tempdir().unwrap();
    let signal = FakeSignal::default();
    let targets = RelayTargets(Arc::new(HashMap::from([(
        "chat.signal.org".to_string(),
        echo.to_string(),
    )])));
    let config = Config {
        static_dir: None,
        frontend_redirect_url: None,
        allowed_origins: parse_allowed_origins("https://arvifoxy.github.io").unwrap(),
        index: Index::open(dir.path().join("index.bin"), signal.packs()).await.unwrap(),
        relay_targets: targets,
        client: ClientConfig { telegram: None },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let mut downgraded = format!("ws://{base}/tunnel/chat.signal.org")
        .into_client_request()
        .unwrap();
    downgraded
        .headers_mut()
        .insert("Origin", format!("http://{base}").parse().unwrap());
    assert!(tokio_tungstenite::connect_async(downgraded).await.is_err());
}

/// Detects: self-hosted static mode allowing http:// downgrade for a non-loopback Host, or rejecting https:// same-origin.
#[tokio::test]
async fn static_relay_allows_https_same_origin_and_rejects_non_loopback_http_downgrade() {
    let echo = echo_server().await;
    let dir = tempfile::tempdir().unwrap();
    let signal = FakeSignal::default();
    let targets = RelayTargets(Arc::new(HashMap::from([(
        "chat.signal.org".to_string(),
        echo.to_string(),
    )])));
    let config = Config {
        static_dir: Some(dir.path().to_path_buf()),
        frontend_redirect_url: None,
        allowed_origins: parse_allowed_origins("https://arvifoxy.github.io").unwrap(),
        index: Index::open(dir.path().join("index.bin"), signal.packs()).await.unwrap(),
        relay_targets: targets,
        client: ClientConfig { telegram: None },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router(config).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Non-loopback Host with http:// Origin is rejected (no scheme downgrade).
    let mut http_remote = format!("ws://{base}/tunnel/chat.signal.org")
        .into_client_request()
        .unwrap();
    http_remote
        .headers_mut()
        .insert("Host", "signal.example".parse().unwrap());
    http_remote
        .headers_mut()
        .insert("Origin", "http://signal.example".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(http_remote).await.is_err());

    // Non-loopback Host with https:// Origin is accepted.
    let mut https_remote = format!("ws://{base}/tunnel/chat.signal.org")
        .into_client_request()
        .unwrap();
    https_remote
        .headers_mut()
        .insert("Host", "signal.example".parse().unwrap());
    https_remote
        .headers_mut()
        .insert("Origin", "https://signal.example".parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(https_remote).await.unwrap();
    let _ = socket.close(None).await;
}

/// Detects: half-configured TLS silently falling back to unencrypted HTTP.
#[test]
fn parse_tls_config_requires_both_cert_and_key_or_neither() {
    assert_eq!(parse_tls_config(None, None).unwrap(), None);
    assert_eq!(
        parse_tls_config(Some("cert.pem".into()), Some("key.pem".into())).unwrap(),
        Some(("cert.pem".into(), "key.pem".into()))
    );
    assert!(parse_tls_config(Some("cert.pem".into()), None).is_err());
    assert!(parse_tls_config(None, Some("key.pem".into())).is_err());
}

/// Detects: unbounded relay connections or idle sockets exhausting file descriptors.
#[tokio::test]
async fn relay_enforces_connection_caps_and_idle_timeout() {
    let listener_up = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = listener_up.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener_up.accept().await {
            held.push(stream);
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let signal = FakeSignal::default();
    let targets = RelayTargets(Arc::new(HashMap::from([(
        "chat.signal.org".to_string(),
        up_addr.to_string(),
    )])));
    let config = Config {
        static_dir: Some(dir.path().to_path_buf()),
        frontend_redirect_url: None,
        allowed_origins: Vec::new(),
        index: Index::open(dir.path().join("index.bin"), signal.packs()).await.unwrap(),
        relay_targets: targets,
        client: ClientConfig { telegram: None },
    };
    let limits = RelayLimits {
        max_connections: 2,
        max_per_ip: 1,
        connect_timeout: Duration::from_secs(2),
        idle_timeout: Duration::from_millis(120),
        max_message_size: 1024,
        max_frame_size: 1024,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        axum::serve(
            listener,
            router_with_relay_limits(config, limits).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let connect_as = |ip: &'static str| {
        let mut req = format!("ws://{base}/tunnel/chat.signal.org")
            .into_client_request()
            .unwrap();
        req.headers_mut().insert("x-forwarded-for", ip.parse().unwrap());
        tokio_tungstenite::connect_async(req)
    };

    let (mut first, _) = connect_as("203.0.113.10").await.unwrap();
    // Second connection from same client hits per-IP limit (429).
    match connect_as("203.0.113.10").await {
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 429),
        other => panic!("expected 429 per-IP refusal, got {other:?}"),
    }
    // Second client takes the second global slot; third hits global limit (503).
    let (_second, _) = connect_as("203.0.113.11").await.unwrap();
    match connect_as("203.0.113.12").await {
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => assert_eq!(resp.status(), 503),
        other => panic!("expected 503 global refusal, got {other:?}"),
    }
    // Idle timeout closes the tunnel and releases its slot.
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(Ok(msg)) = first.next().await {
            if matches!(msg, Message::Close(_)) {
                return true;
            }
        }
        true
    })
    .await;
    assert!(closed.is_ok(), "idle tunnel must close after idle_timeout");
    // After idle shutdown releases permits, a new client can connect again.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (mut reopened, _) = connect_as("203.0.113.10").await.unwrap();
    let _ = reopened.close(None).await;
}

/// Detects: cancelling a client HTTP request mid-append leaving disk and memory out of sync or misaligned.
#[tokio::test]
async fn cancelled_append_keeps_disk_and_memory_consistent() {
    let server = Arc::new(start(RelayTargets::signal()).await);
    let held = server.signal.hold.clone().write_owned().await;
    let url = format!("http://{}/v1/sticker-packs/index", server.base);
    let client = reqwest::Client::new();
    let req = tokio::spawn({
        let url = url.clone();
        async move {
            let _ = client.post(url).body(entry_for(11, 22)).send().await;
        }
    });
    while server.signal.asked() < 1 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(held);
    // Abort immediately as the append transitions to disk write.
    req.abort();
    let _ = req.await;
    tokio::time::sleep(Duration::from_millis(50)).await;

    let disk = std::fs::read(&server.index_path).unwrap_or_default();
    let memory = server.index().await;
    assert_eq!(disk.len() % ENTRY_LEN, 0);
    assert_eq!(disk, memory);
}

/// Checks the question to Signal's CDN against the real one. It needs the network, and SIGNAL_PACK_ID with the 32
/// hexadecimal digits of a sticker pack that exists: `SIGNAL_PACK_ID=... cargo test -- --ignored`.
#[tokio::test]
#[ignore]
async fn signals_cdn_says_which_packs_exist() {
    let digits = std::env::var("SIGNAL_PACK_ID").expect("SIGNAL_PACK_ID names an existing pack");
    let existing: [u8; 16] = std::array::from_fn(|i| u8::from_str_radix(&digits[2 * i..2 * i + 2], 16).unwrap());
    let cdn = signal_cdn();
    assert_eq!(cdn(existing).await, OnSignal::Exists);
    let mut other = existing;
    other[15] ^= 1;
    other[0] ^= 0x55;
    assert_eq!(cdn(other).await, OnSignal::Missing);
}
