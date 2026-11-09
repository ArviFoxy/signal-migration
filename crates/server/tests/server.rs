//! Tests over real HTTP and WebSocket connections to a server on an ephemeral local port.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use signal_migration_server::index::{AddressLimiter, ENTRY_LEN, Index};
use signal_migration_server::relay::RelayTargets;
use signal_migration_server::{Config, router};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct TestServer {
    base: String,
    index_path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

async fn start(relay_targets: RelayTargets) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let index_path = dir.path().join("index.bin");
    let config = Config { static_dir: dir.path().to_path_buf(), index: Index::open(index_path.clone()).await.unwrap(), relay_targets };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router(config).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    TestServer { base: format!("127.0.0.1:{}", address.port()), index_path, _dir: dir }
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

/// Detects: the relay dropping, reordering or altering bytes in either direction.
#[tokio::test]
async fn relay_carries_bytes_both_ways_to_an_allowed_host() {
    let echo = echo_server().await;
    let targets = RelayTargets(Arc::new(HashMap::from([("chat.signal.org".to_string(), echo.to_string())])));
    let server = start(targets).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/tunnel/chat.signal.org", server.base)).await.unwrap();
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
    let status = client.post(format!("http://{}/v1/sticker-packs/index", server.base)).body(entry(7)).send().await.unwrap().status();
    assert_eq!(status, 201);
    let body = client.get(format!("http://{}/v1/sticker-packs/index", server.base)).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(body.as_ref(), entry(7).as_slice());

    let reopened = Index::open(server.index_path.clone()).await.unwrap();
    let restarted = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = Config { static_dir: std::env::temp_dir(), index: reopened, relay_targets: RelayTargets::signal() };
        tokio::spawn(async move { axum::serve(listener, router(config).into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
        address
    };
    let body = client.get(format!("http://{restarted}/v1/sticker-packs/index")).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(body.as_ref(), entry(7).as_slice());
}

/// Detects: malformed entries entering the fixed-width index file and shifting every later entry.
#[tokio::test]
async fn entry_of_wrong_length_is_rejected() {
    let server = start(RelayTargets::signal()).await;
    let status = reqwest::Client::new().post(format!("http://{}/v1/sticker-packs/index", server.base)).body(vec![1u8; ENTRY_LEN - 1]).send().await.unwrap().status();
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
    let body = client.get(format!("{url}?from=2")).send().await.unwrap().bytes().await.unwrap();
    assert_eq!(body.as_ref(), entry(3).as_slice());
}

/// Detects: two uploaders both being allowed to upload the same pack at once.
#[tokio::test]
async fn second_claim_for_the_same_pack_is_refused_while_the_first_holds() {
    let server = start(RelayTargets::signal()).await;
    let client = reqwest::Client::new();
    let url = format!("http://{}/v1/sticker-packs/claims", server.base);
    assert_eq!(client.post(&url).body(vec![9u8; 32]).send().await.unwrap().status(), 201);
    assert_eq!(client.post(&url).body(vec![9u8; 32]).send().await.unwrap().status(), 409);
    assert_eq!(client.post(&url).body(vec![8u8; 32]).send().await.unwrap().status(), 201);
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
