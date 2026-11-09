//! The signal-migration server: one origin that serves the web app, relays its encrypted tunnels to
//! Signal, and keeps the sticker pack index.

pub mod index;
pub mod relay;

use std::path::PathBuf;

use axum::Router;
use axum::routing::{get, post};
use tower_http::services::ServeDir;

pub struct Config {
    pub static_dir: PathBuf,
    pub index: index::Index,
    pub relay_targets: relay::RelayTargets,
    /// Development only: accept event lines from the diagnostics page and print them.
    pub diagnostics_log: bool,
}

/// Prints one event line from the diagnostics page (truncated; the page sends no secrets).
async fn diagnostics_log(body: axum::body::Bytes) -> axum::http::StatusCode {
    let line = String::from_utf8_lossy(&body[..body.len().min(500)]).replace(['\r', '\n'], " ");
    println!("page: {line}");
    axum::http::StatusCode::NO_CONTENT
}

pub fn router(config: Config) -> Router {
    let index_routes = Router::new()
        .route("/v1/sticker-packs/index", get(index::read).post(index::append))
        .route("/v1/sticker-packs/claims", post(index::claim))
        .with_state(config.index);
    let relay_routes = Router::new().route("/tunnel/{host}", get(relay::tunnel)).with_state(config.relay_targets);
    let mut app = Router::new().merge(index_routes).merge(relay_routes);
    if config.diagnostics_log {
        app = app.route("/v1/diagnostics/log", post(diagnostics_log));
    }
    app.fallback_service(ServeDir::new(config.static_dir))
}
