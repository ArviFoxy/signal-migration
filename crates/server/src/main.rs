//! Configuration comes from the environment:
//! `HOST` and `PORT` (default 127.0.0.1:8080), `INDEX_FILE` (the sticker pack index), optionally `STATIC_DIR` (the
//! built web app; omit when hosting the frontend on GitHub Pages), optionally `FRONTEND_REDIRECT_URL` (where `GET /`
//! redirects when `STATIC_DIR` is unset), optionally `ALLOWED_ORIGINS` (comma-separated browser origins allowed for
//! CORS on `/v1/*` and WebSocket `Origin` checks on `/tunnel/{host}`), and optionally `TLS_CERT` and `TLS_KEY` (PEM
//! files) to serve HTTPS.
//! `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are the Telegram app identity from my.telegram.org; without them the
//! page cannot log in to Telegram. `TELEGRAM_TEST_DC=1` makes the page log in to Telegram's test environment, for
//! development.

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

use signal_migration_server::{
    ClientConfig, Config, TelegramApp,
    index::{Index, signal_cdn},
    parse_allowed_origins, parse_tls_config,
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

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = format!(
        "{}:{}",
        env::var("HOST").unwrap_or("127.0.0.1".into()),
        env::var("PORT").unwrap_or("8080".into())
    )
    .parse()?;
    let static_dir = non_empty_env("STATIC_DIR").map(PathBuf::from);
    let frontend_redirect_url = non_empty_env("FRONTEND_REDIRECT_URL");
    if let Some(url) = &frontend_redirect_url
        && !url.starts_with("https://")
        && !url.starts_with("http://")
    {
        return Err(format!("FRONTEND_REDIRECT_URL must start with http:// or https://: {url}").into());
    }
    let allowed_origins = match non_empty_env("ALLOWED_ORIGINS") {
        Some(raw) => parse_allowed_origins(&raw)?,
        None => Vec::new(),
    };
    let tls_files = parse_tls_config(non_empty_env("TLS_CERT"), non_empty_env("TLS_KEY"))?;
    let app = router(Config {
        static_dir,
        frontend_redirect_url,
        allowed_origins,
        index: Index::open(PathBuf::from(env::var("INDEX_FILE")?), signal_cdn()).await?,
        relay_targets: RelayTargets::signal(),
        client: ClientConfig {
            telegram: telegram_app()?,
        },
    })
    .into_make_service_with_connect_info::<SocketAddr>();

    match tls_files {
        Some((cert, key)) => {
            rustls::crypto::ring::default_provider()
                .install_default()
                .map_err(|_| "a TLS provider is already installed")?;
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
            println!("https://{address}/");
            axum_server::bind_rustls(address, tls).serve(app).await?;
        }
        None => {
            println!("http://{address}/");
            axum::serve(tokio::net::TcpListener::bind(address).await?, app).await?;
        }
    }
    Ok(())
}
