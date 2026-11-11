//! Configuration comes from the environment:
//! `HOST` and `PORT` (default 127.0.0.1:8080), `STATIC_DIR` (the built web app), `INDEX_FILE`
//! (the sticker pack index), and optionally `TLS_CERT` and `TLS_KEY` (PEM files) to serve HTTPS.
//! `MODE=demo` serves only the demo's files (STATIC_DIR, built by `node build.mjs --demo`): no tunnel, no index, and
//! it refuses to start with a Telegram key.
//! `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are the Telegram app identity from my.telegram.org; without them the
//! page cannot log in to Telegram. `TELEGRAM_TEST_DC=1` makes the page log in to Telegram's test environment, for
//! development.

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use signal_migration_server::{
    ClientConfig, Config, TelegramApp, demo_router,
    index::{Index, signal_cdn},
    relay::RelayTargets,
    router,
};

fn telegram_app() -> Result<Option<TelegramApp>, Box<dyn std::error::Error>> {
    match (env::var("TELEGRAM_API_ID"), env::var("TELEGRAM_API_HASH")) {
        (Ok(id), Ok(hash)) => Ok(Some(TelegramApp {
            api_id: id.parse()?,
            api_hash: hash,
            test_dc: env::var("TELEGRAM_TEST_DC").is_ok_and(|value| value == "1"),
        })),
        (Err(_), Err(_)) => Ok(None),
        _ => Err("set both TELEGRAM_API_ID and TELEGRAM_API_HASH, or neither".into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = format!(
        "{}:{}",
        env::var("HOST").unwrap_or("127.0.0.1".into()),
        env::var("PORT").unwrap_or("8080".into())
    )
    .parse()?;
    let static_dir = PathBuf::from(env::var("STATIC_DIR")?);
    let app = if env::var("MODE").is_ok_and(|mode| mode == "demo") {
        if env::var("TELEGRAM_API_ID").is_ok() || env::var("TELEGRAM_API_HASH").is_ok() {
            return Err("the demo runs without keys: unset TELEGRAM_API_ID and TELEGRAM_API_HASH".into());
        }
        demo_router(static_dir)
    } else {
        router(Config {
            static_dir,
            index: Index::open(PathBuf::from(env::var("INDEX_FILE")?), signal_cdn()).await?,
            relay_targets: RelayTargets::signal(),
            client: ClientConfig {
                telegram: telegram_app()?,
            },
        })
    }
    .into_make_service_with_connect_info::<SocketAddr>();

    match (env::var("TLS_CERT"), env::var("TLS_KEY")) {
        (Ok(cert), Ok(key)) => {
            rustls::crypto::ring::default_provider()
                .install_default()
                .map_err(|_| "a TLS provider is already installed")?;
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
            println!("https://{address}/");
            axum_server::bind_rustls(address, tls).serve(app).await?;
        }
        _ => {
            println!("http://{address}/");
            axum::serve(tokio::net::TcpListener::bind(address).await?, app).await?;
        }
    }
    Ok(())
}
