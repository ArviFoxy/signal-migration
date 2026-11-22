//! The signal-migration server: relays encrypted TLS tunnels to Signal, keeps the sticker pack index, serves
//! deployment configuration, and optionally serves the built web app static files.

pub mod index;
pub mod relay;

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, header};
use axum::middleware::{self, Next};
use axum::response::{Redirect, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;

/// The Telegram app identity that TDLib in the page logs in with (from my.telegram.org). Every Telegram client
/// ships its own, so it is not a secret; it is configuration rather than part of the source.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramApp {
    pub api_id: i32,
    pub api_hash: String,
    /// Log in to Telegram's test environment (separate servers and accounts, for development) instead.
    pub test_dc: bool,
}

/// What the page needs to know about this deployment.
#[derive(Clone, Serialize)]
pub struct ClientConfig {
    pub telegram: Option<TelegramApp>,
}

pub struct Config {
    /// Directory containing the built static web app, or `None` when the frontend is hosted elsewhere (e.g. GitHub Pages).
    pub static_dir: Option<PathBuf>,
    /// Optional URL to redirect `GET /` to when `static_dir` is `None`.
    pub frontend_redirect_url: Option<String>,
    /// Cross-origin frontends permitted for `/v1/*` CORS and `/tunnel/{host}` WebSocket `Origin` checks.
    pub allowed_origins: Vec<HeaderValue>,
    pub index: index::Index,
    pub relay_targets: relay::RelayTargets,
    pub client: ClientConfig,
}

/// Validates and parses a comma-separated list of HTTP(S) origins (`scheme://host[:port]`, no path or trailing slash).
pub fn parse_allowed_origins(raw: &str) -> Result<Vec<HeaderValue>, String> {
    let mut origins = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let rest = trimmed
            .strip_prefix("https://")
            .or_else(|| trimmed.strip_prefix("http://"))
            .ok_or_else(|| format!("allowed origin must start with http:// or https://: {trimmed}"))?;
        if rest.is_empty() || rest.contains('/') || rest.contains('?') || rest.contains('#') {
            return Err(format!(
                "allowed origin must be scheme://host[:port] with no path: {trimmed}"
            ));
        }
        let value =
            HeaderValue::from_str(trimmed).map_err(|_| format!("allowed origin is not a valid header: {trimmed}"))?;
        origins.push(value);
    }
    Ok(origins)
}

async fn client_config(State(config): State<ClientConfig>) -> Json<ClientConfig> {
    Json(config)
}

/// Unhashed app assets (index.html, attestation files) must revalidate on deploy; content-hashed fonts are immutable.
async fn cache_headers(request: Request, next: Next) -> Response {
    let is_hashed_font = request.uri().path().starts_with("/fonts/");
    let mut response = next.run(request).await;
    if !response.headers().contains_key(header::CACHE_CONTROL) {
        let value = if is_hashed_font {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            HeaderValue::from_static("no-cache")
        };
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    response
}

pub fn router(config: Config) -> Router {
    let index_routes = Router::new()
        .route("/v1/sticker-packs/index", get(index::read).post(index::append))
        .with_state(config.index);
    let config_routes = Router::new()
        .route("/v1/config", get(client_config))
        .with_state(config.client);
    let mut api_routes = Router::new().merge(index_routes).merge(config_routes);
    if !config.allowed_origins.is_empty() {
        let cors = CorsLayer::new()
            .allow_origin(AllowOrigin::list(config.allowed_origins.clone()))
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers([header::CONTENT_TYPE]);
        api_routes = api_routes.layer(cors);
    }

    let relay_routes = Router::new()
        .route("/tunnel/{host}", get(relay::tunnel))
        .with_state(relay::RelayState {
            targets: config.relay_targets,
            allowed_origins: Arc::new(config.allowed_origins),
        });

    let mut app = Router::new().merge(api_routes).merge(relay_routes);
    if let Some(static_dir) = config.static_dir {
        // Built files have brotli and gzip copies next to them (app/build.mjs); a browser that accepts one gets it.
        app = app.fallback_service(ServeDir::new(static_dir).precompressed_br().precompressed_gzip());
    } else if let Some(target) = config.frontend_redirect_url {
        app = app.route("/", get(move || async move { Redirect::temporary(&target) }));
    }
    app.layer(middleware::from_fn(cache_headers))
}
