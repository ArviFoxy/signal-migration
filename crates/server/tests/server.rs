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
use signal_migration_server::relay::RelayTargets;
use signal_migration_server::{ClientConfig, Config, TelegramApp, demo_router, router};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

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
        static_dir: dir.path().to_path_buf(),
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
            static_dir: std::env::temp_dir(),
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

/// Detects: the demo server relaying to Signal, serving the index or a configuration, which would let the demo reach
/// real services.
#[tokio::test]
async fn demo_server_serves_only_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), b"demo").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = demo_router(dir.path().to_path_buf());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap()
    });
    let client = reqwest::Client::new();
    let page = client.get(format!("http://{address}/")).send().await.unwrap();
    assert_eq!(page.bytes().await.unwrap().as_ref(), b"demo");
    for path in ["/tunnel/chat.signal.org", "/v1/config", "/v1/sticker-packs/index"] {
        let status = client
            .get(format!("http://{address}{path}"))
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, 404, "{path}");
    }
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
        static_dir: std::env::temp_dir(),
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

/// Detects: two entries for one Signal pack both added when they arrive together, each having seen that the pack
/// was not listed before Signal's CDN answered.
#[tokio::test]
async fn two_entries_for_one_pack_that_arrive_together_give_one_entry() {
    let server = Arc::new(start(RelayTargets::signal()).await);
    let held = server.signal.hold.clone().write_owned().await;
    let first = tokio::spawn({
        let server = server.clone();
        async move { server.add(entry_for(1, 9)).await }
    });
    let second = tokio::spawn({
        let server = server.clone();
        async move { server.add(entry_for(2, 9)).await }
    });
    while server.signal.asked() < 2 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(held);
    let mut answers = [first.await.unwrap(), second.await.unwrap()];
    answers.sort();
    assert_eq!(answers, [201, 409]);
    assert_eq!(server.index().await.len(), ENTRY_LEN);
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
