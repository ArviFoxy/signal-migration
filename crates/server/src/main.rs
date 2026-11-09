//! Configuration comes from the environment:
//! `HOST` and `PORT` (default 127.0.0.1:8080), `STATIC_DIR` (the built web app), `INDEX_FILE`
//! (the sticker pack index), and optionally `TLS_CERT` and `TLS_KEY` (PEM files) to serve HTTPS.
//! `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are the Telegram app identity from my.telegram.org; without them the
//! page cannot log in to Telegram.
//! `DIAGNOSTICS_LOG=1` (development only) prints event lines posted by the diagnostics page.

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use signal_migration_server::{ClientConfig, Config, TelegramApp, index::Index, relay::RelayTargets, router};

fn telegram_app() -> Result<Option<TelegramApp>, Box<dyn std::error::Error>> {
    match (env::var("TELEGRAM_API_ID"), env::var("TELEGRAM_API_HASH")) {
        (Ok(id), Ok(hash)) => Ok(Some(TelegramApp { api_id: id.parse()?, api_hash: hash })),
        (Err(_), Err(_)) => Ok(None),
        _ => Err("set both TELEGRAM_API_ID and TELEGRAM_API_HASH, or neither".into()),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = format!("{}:{}", env::var("HOST").unwrap_or("127.0.0.1".into()), env::var("PORT").unwrap_or("8080".into())).parse()?;
    let config = Config {
        static_dir: PathBuf::from(env::var("STATIC_DIR")?),
        index: Index::open(PathBuf::from(env::var("INDEX_FILE")?)).await?,
        relay_targets: RelayTargets::signal(),
        diagnostics_log: env::var("DIAGNOSTICS_LOG").is_ok_and(|v| v == "1"),
        client: ClientConfig { telegram: telegram_app()? },
    };
    let app = router(config).into_make_service_with_connect_info::<SocketAddr>();

    match (env::var("TLS_CERT"), env::var("TLS_KEY")) {
        (Ok(cert), Ok(key)) => {
            rustls::crypto::ring::default_provider().install_default().map_err(|_| "a TLS provider is already installed")?;
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
