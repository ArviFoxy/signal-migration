//! The signal-migration server: relays encrypted TLS tunnels to Signal, keeps the sticker pack index, serves
//! deployment configuration, and optionally serves the built web app static files.

pub mod index;
pub mod relay;

use std::path::PathBuf;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderValue, Method, Uri, header};
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

/// Validates TLS environment variables: both `TLS_CERT` and `TLS_KEY` must be set together, or neither.
pub fn parse_tls_config(cert: Option<String>, key: Option<String>) -> Result<Option<(String, String)>, String> {
    match (cert, key) {
        (Some(cert), Some(key)) => Ok(Some((cert, key))),
        (None, None) => Ok(None),
        _ => Err("set both TLS_CERT and TLS_KEY, or neither".to_string()),
    }
}

/// Validates, normalizes to lowercase, and parses a comma-separated list of HTTP(S) origins (`scheme://host[:port]`,
/// no path, query, fragment, userinfo, or whitespace). Rejects non-empty strings that contain no valid origins.
pub fn parse_allowed_origins(raw: &str) -> Result<Vec<HeaderValue>, String> {
    let mut origins = Vec::new();
    for part in raw.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().any(char::is_whitespace) {
            return Err(format!("allowed origin contains whitespace: {trimmed}"));
        }
        let uri: Uri = trimmed
            .parse()
            .map_err(|_| format!("allowed origin is not a valid URI: {trimmed}"))?;
        let Some(scheme) = uri.scheme_str() else {
            return Err(format!("allowed origin must start with http:// or https://: {trimmed}"));
        };
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return Err(format!("allowed origin must start with http:// or https://: {trimmed}"));
        }
        let Some(rest) = trimmed.get(scheme.len()..).and_then(|s| s.strip_prefix("://")) else {
            return Err(format!("allowed origin must start with http:// or https://: {trimmed}"));
        };
        if rest.is_empty() || rest.contains('/') || rest.contains('?') || rest.contains('#') {
            return Err(format!(
                "allowed origin must be scheme://host[:port] with no path: {trimmed}"
            ));
        }
        let Some(authority) = uri.authority() else {
            return Err(format!("allowed origin is missing a host: {trimmed}"));
        };
        if authority.as_str().contains('@') || authority.host().is_empty() {
            return Err(format!("allowed origin must be scheme://host[:port]: {trimmed}"));
        }
        let normalized = format!("{scheme}://{}", authority.as_str().to_ascii_lowercase());
        let value = HeaderValue::from_str(&normalized)
            .map_err(|_| format!("allowed origin is not a valid header: {trimmed}"))?;
        origins.push(value);
    }
    if !raw.trim().is_empty() && origins.is_empty() {
        return Err("ALLOWED_ORIGINS did not contain any valid origins".to_string());
    }
    Ok(origins)
}

async fn client_config(State(config): State<ClientConfig>) -> Json<ClientConfig> {
    Json(config)
}

/// Unhashed app assets (index.html, attestation files) must revalidate on deploy; successful content-hashed fonts are immutable.
async fn cache_headers(request: Request, next: Next) -> Response {
    let is_hashed_font = request.uri().path().starts_with("/fonts/");
    let mut response = next.run(request).await;
    if !response.headers().contains_key(header::CACHE_CONTROL) {
        let value = if is_hashed_font && response.status().is_success() {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            HeaderValue::from_static("no-cache")
        };
        response.headers_mut().insert(header::CACHE_CONTROL, value);
    }
    response
}

pub fn router(config: Config) -> Router {
    router_with_relay_limits(config, relay::RelayLimits::default())
}

pub fn router_with_relay_limits(config: Config, relay_limits: relay::RelayLimits) -> Router {
    let index_routes = Router::new()
        .route("/v1/sticker-packs/index", get(index::read).post(index::append))
        .layer(DefaultBodyLimit::max(index::ENTRY_LEN))
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

    let allow_same_origin = config.static_dir.is_some();
    let relay_routes = Router::new()
        .route("/tunnel/{host}", get(relay::tunnel))
        .with_state(relay::RelayState::new(
            config.relay_targets,
            config.allowed_origins,
            allow_same_origin,
            relay_limits,
        ));

    let mut app = Router::new().merge(api_routes).merge(relay_routes);
    if let Some(static_dir) = config.static_dir {
        // Built files have brotli and gzip copies next to them (app/build.mjs); a browser that accepts one gets it.
        app = app.fallback_service(ServeDir::new(static_dir).precompressed_br().precompressed_gzip());
    } else if let Some(target) = config.frontend_redirect_url {
        app = app.route("/", get(move || async move { Redirect::temporary(&target) }));
    }
    app.layer(middleware::from_fn(cache_headers))
}
