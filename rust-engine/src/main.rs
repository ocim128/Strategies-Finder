//! Trading Engine HTTP/WebSocket Server
//!
//! Provides REST API and WebSocket endpoints for:
//! - Single backtests
//! - Walk-forward optimization
//! - Strategy finder
use axum::{
    extract::DefaultBodyLimit,
    http::{header, HeaderValue, Method},
    routing::{get, post},
    Json, Router,
};
use std::net::SocketAddr;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use trading_engine::api::routes;
const MAX_JSON_BODY_BYTES: usize = 256 * 1024 * 1024;

fn cors_origins(configured_origin: Option<&str>) -> Vec<HeaderValue> {
    let mut origins = vec![
        HeaderValue::from_static("http://localhost:5173"),
        HeaderValue::from_static("http://127.0.0.1:5173"),
    ];
    if let Some(origin) = configured_origin
        .map(str::trim)
        .map(|origin| origin.trim_end_matches('/'))
        .filter(|origin| origin.starts_with("http://") || origin.starts_with("https://"))
    {
        if let Ok(value) = HeaderValue::try_from(origin) {
            if !origins.contains(&value) {
                origins.push(value);
            }
        }
    }
    origins
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "trading_engine=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    // CORS configuration for browser access
    let configured_origin = std::env::var("VITE_DEV_SERVER_ORIGIN").ok();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(cors_origins(
            configured_origin.as_deref(),
        )))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    // Shared application state (for data caching)
    let state = routes::AppState::default();
    // Build router
    let app = Router::new()
        // Health check
        .route("/api/health", get(health_check))
        // Backtest endpoints
        .route("/api/backtest", post(routes::backtest_handler))
        .route("/api/backtest/batch", post(routes::batch_backtest_handler))
        .route(
            "/api/backtest/fresh-entry/batch",
            post(routes::fresh_entry_batch_handler),
        )
        .route(
            "/api/backtest/asset-opportunity/batch",
            post(routes::asset_opportunity_batch_handler),
        )
        // Cached data endpoints (for large datasets)
        .route("/api/data/cache", post(routes::cache_data_handler))
        .route(
            "/api/data/multi-cache",
            post(routes::multi_cache_data_handler),
        )
        .route("/api/data/clear", post(routes::clear_cache_handler))
        .route(
            "/api/backtest/batch/cached",
            post(routes::cached_batch_backtest_handler),
        )
        .route(
            "/api/backtest/fresh-entry/batch/cached",
            post(routes::cached_fresh_entry_batch_handler),
        )
        .route(
            "/api/backtest/asset-opportunity/batch/cached",
            post(routes::cached_asset_opportunity_batch_handler),
        )
        .route(
            "/api/backtest/asset-opportunity/multi-batch",
            post(routes::multi_asset_opportunity_batch_handler),
        )
        .route(
            "/api/backtest/fresh-entry/multi-batch",
            post(routes::multi_asset_fresh_entry_batch_handler),
        )
        // Walk-forward endpoints
        .route("/api/walk-forward", post(routes::walk_forward_handler))
        // Finder endpoints
        .route("/api/finder", post(routes::finder_handler))
        // Proxy endpoint for external APIs (CORS bypass)
        .route("/api/proxy", post(routes::proxy_handler))
        // WebSocket for progress streaming
        .route("/ws/optimizer", get(routes::ws_handler))
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(cors);
    // Start server
    let addr = SocketAddr::from(([127, 0, 0, 1], 3030));
    tracing::info!("🚀 Trading Engine server starting on http://{}", addr);
    tracing::info!("📊 Endpoints:");
    tracing::info!("   POST /api/backtest            - Run single backtest");
    tracing::info!("   POST /api/backtest/batch      - Run parallel batch backtests");
    tracing::info!("   POST /api/backtest/fresh-entry/batch - Run compact fresh-entry summaries");
    tracing::info!(
        "   POST /api/backtest/asset-opportunity/batch - Run scalar Asset Opportunity batches"
    );
    tracing::info!("   POST /api/data/cache          - Cache OHLCV data (returns cache_id)");
    tracing::info!(
        "   POST /api/data/multi-cache     - Cache multiple OHLCV datasets (returns cache_ids)"
    );
    tracing::info!("   POST /api/backtest/batch/cached - Run batch with cached data");
    tracing::info!(
        "   POST /api/backtest/fresh-entry/batch/cached - Run cached fresh-entry summaries"
    );
    tracing::info!("   POST /api/backtest/asset-opportunity/batch/cached - Run cached scalar Asset Opportunity batches");
    tracing::info!("   POST /api/backtest/asset-opportunity/multi-batch - Run multi-asset scalar Asset Opportunity batches");
    tracing::info!(
        "   POST /api/backtest/fresh-entry/multi-batch - Run multi-asset fresh-entry summaries"
    );
    tracing::info!("   POST /api/walk-forward        - Run walk-forward analysis");
    tracing::info!("   POST /api/finder              - Run strategy finder");
    tracing::info!("   WS   /ws/optimizer            - Stream progress updates");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
/// Health check endpoint
async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "healthy",
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "trading-engine-rust"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_allows_only_expected_local_origins() {
        let origins = cors_origins(Some("http://localhost:4173/"));
        assert!(origins
            .iter()
            .any(|origin| origin == "http://localhost:5173"));
        assert!(origins
            .iter()
            .any(|origin| origin == "http://127.0.0.1:5173"));
        assert!(origins
            .iter()
            .any(|origin| origin == "http://localhost:4173"));
        assert!(!origins
            .iter()
            .any(|origin| origin == "https://evil.example"));
    }
}
