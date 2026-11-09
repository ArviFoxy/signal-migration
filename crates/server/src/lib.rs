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
}

pub fn router(config: Config) -> Router {
    let index_routes = Router::new()
        .route("/v1/sticker-packs/index", get(index::read).post(index::append))
        .route("/v1/sticker-packs/claims", post(index::claim))
        .with_state(config.index);
    let relay_routes = Router::new().route("/tunnel/{host}", get(relay::tunnel)).with_state(config.relay_targets);
    Router::new().merge(index_routes).merge(relay_routes).fallback_service(ServeDir::new(config.static_dir))
}
