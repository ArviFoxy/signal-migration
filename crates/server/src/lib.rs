//! The signal-migration server: one origin that serves the web app, relays its encrypted tunnels to
//! Signal, and keeps the sticker pack index.

pub mod index;
pub mod relay;

use std::path::PathBuf;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use tower_http::services::ServeDir;

/// The Telegram app identity that TDLib in the page logs in with (from my.telegram.org). Every Telegram client
/// ships its own, so it is not a secret; it is configuration rather than part of the source.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramApp {
    pub api_id: i32,
    pub api_hash: String,
}

/// What the page needs to know about this deployment.
#[derive(Clone, Serialize)]
pub struct ClientConfig {
    pub telegram: Option<TelegramApp>,
}

pub struct Config {
    pub static_dir: PathBuf,
    pub index: index::Index,
    pub relay_targets: relay::RelayTargets,
    pub client: ClientConfig,
}

async fn client_config(State(config): State<ClientConfig>) -> Json<ClientConfig> {
    Json(config)
}

/// The demo: only the built demo's files (app/dist-demo). No tunnel to Signal, no sticker pack index and no
/// configuration, so that nothing the demo does can reach a real service.
pub fn demo_router(static_dir: PathBuf) -> Router {
    Router::new().fallback_service(ServeDir::new(static_dir).precompressed_br().precompressed_gzip())
}

pub fn router(config: Config) -> Router {
    let index_routes = Router::new()
        .route("/v1/sticker-packs/index", get(index::read).post(index::append))
        .route("/v1/sticker-packs/claims", post(index::claim))
        .with_state(config.index);
    let relay_routes = Router::new()
        .route("/tunnel/{host}", get(relay::tunnel))
        .with_state(config.relay_targets);
    let config_routes = Router::new()
        .route("/v1/config", get(client_config))
        .with_state(config.client);
    let app = Router::new()
        .merge(index_routes)
        .merge(relay_routes)
        .merge(config_routes);
    // Built files have brotli and gzip copies next to them (app/build.mjs); a browser that accepts one gets it.
    app.fallback_service(ServeDir::new(config.static_dir).precompressed_br().precompressed_gzip())
}
