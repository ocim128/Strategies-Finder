//! Trading Engine HTTP Server
//!
//! Provides REST API endpoints for:
//! - Single backtests
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use trading_engine::api::routes::{self, AppState, RequestId};
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

/// Parse the `RUST_ENGINE_MAX_IN_FLIGHT` admission setting. The value is read
/// once at startup: it must be a positive integer, and the conservative
/// default applies when unset.
fn max_in_flight_from(value: Option<&str>) -> Result<usize, String> {
    match value {
        None => Ok(routes::DEFAULT_MAX_IN_FLIGHT),
        Some(raw) => raw
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|limit| *limit > 0)
            .ok_or_else(|| {
                format!("RUST_ENGINE_MAX_IN_FLIGHT must be a positive integer, got '{raw}'")
            }),
    }
}

/// Admission gate for the CPU-heavy routes. Overloaded requests are rejected
/// before JSON parsing with a 503; accepted requests carry their semaphore
/// permit in request extensions so handlers retain capacity through the whole
/// blocking computation. Health and cache-clear routes never pass through
/// this gate, and the CORS layer wraps it so rejected browser requests keep
/// their CORS headers.
async fn admission_gate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let request_id = state.next_request_id();
    let route = request.uri().path().to_owned();
    let Ok(permit) = state.max_in_flight.clone().try_acquire_owned() else {
        tracing::warn!(
            request_id,
            route = %route,
            limit = state.max_in_flight_limit(),
            "admission rejected; engine busy"
        );
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Engine busy: too many in-flight requests",
        )
            .into_response();
    };
    let permit = Arc::new(permit);
    let mut request = request;
    request.extensions_mut().insert(RequestId(request_id));
    // The middleware keeps its own permit reference through response
    // construction, alongside the reference handlers retain through their
    // blocking computation. Without it, capacity would free as soon as the
    // worker finished and new requests could enter while a large response is
    // still being serialized.
    request.extensions_mut().insert(permit.clone());
    let response = next.run(request).await;
    drop(permit);
    response
}

fn build_router(state: AppState, cors: CorsLayer) -> Router {
    let admission = middleware::from_fn_with_state(state.clone(), admission_gate);
    Router::new()
        // Health check stays outside the admission gate.
        .route("/api/health", get(health_check))
        // Backtest endpoints
        .route(
            "/api/backtest",
            post(routes::backtest_handler).route_layer(admission.clone()),
        )
        .route(
            "/api/backtest/batch",
            post(routes::batch_backtest_handler).route_layer(admission.clone()),
        )
        // Cached data endpoints (for large datasets); cache clear stays
        // outside the gate, cache upload is CPU-heavy and admitted.
        .route(
            "/api/data/cache",
            post(routes::cache_data_handler).route_layer(admission.clone()),
        )
        .route("/api/data/clear", post(routes::clear_cache_handler))
        .route(
            "/api/backtest/batch/cached",
            post(routes::cached_batch_backtest_handler).route_layer(admission),
        )
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(cors)
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
    let max_in_flight =
        match max_in_flight_from(std::env::var("RUST_ENGINE_MAX_IN_FLIGHT").ok().as_deref()) {
            Ok(limit) => limit,
            Err(message) => {
                eprintln!("Startup error: {message}");
                std::process::exit(2);
            }
        };
    // CORS configuration for browser access
    let configured_origin = std::env::var("VITE_DEV_SERVER_ORIGIN").ok();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(cors_origins(
            configured_origin.as_deref(),
        )))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    // Shared application state (for data caching)
    let state = AppState::new(max_in_flight);
    tracing::info!(
        "Admission limit: {max_in_flight} in-flight CPU-heavy requests (RUST_ENGINE_MAX_IN_FLIGHT)"
    );
    // Build router
    let app = build_router(state, cors);
    // Start server. Keep the historical default, but allow an isolated local
    // instance for smoke tests when another engine owns 3030.
    let addr = SocketAddr::from(([127, 0, 0, 1], server_port()));
    tracing::info!("🚀 Trading Engine server starting on http://{}", addr);
    tracing::info!("📊 Endpoints:");
    tracing::info!("   POST /api/backtest            - Run single backtest");
    tracing::info!("   POST /api/backtest/batch      - Run parallel batch backtests");
    tracing::info!("   POST /api/data/cache          - Cache OHLCV data (returns cache_id)");
    tracing::info!("   POST /api/backtest/batch/cached - Run batch with cached data");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn server_port() -> u16 {
    server_port_from(std::env::var("RUST_ENGINE_PORT").ok().as_deref())
}

fn server_port_from(value: Option<&str>) -> u16 {
    value
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(3030)
}

/// Health check endpoint
async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "healthy",
        "version": env!("CARGO_PKG_VERSION"),
        "engine": "trading-engine-rust",
        "protocolVersion": 2,
        "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "capabilities": {
            "backtest.next_open.v1": true,
            "backtest.risk_max_hold.v1": true,
            "backtest.risk_cooldown.v1": true,
            "backtest.exit_reason.v1": true
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Extension;
    use http_body_util::BodyExt;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::sync::OwnedSemaphorePermit;

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

    #[tokio::test]
    async fn health_advertises_the_versioned_backtest_capabilities() {
        let Json(payload) = health_check().await;
        assert_eq!(payload["status"], "healthy");
        assert_eq!(payload["engine"], "trading-engine-rust");
        assert_eq!(payload["protocolVersion"], 2);
        assert_eq!(
            payload["buildProfile"],
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        );
        for capability in [
            "backtest.next_open.v1",
            "backtest.risk_max_hold.v1",
            "backtest.risk_cooldown.v1",
            "backtest.exit_reason.v1",
        ] {
            assert_eq!(payload["capabilities"][capability], true);
        }
    }

    #[test]
    fn server_port_uses_a_valid_nonzero_override() {
        assert_eq!(server_port_from(Some("3031")), 3031);
        assert_eq!(server_port_from(Some("0")), 3030);
        assert_eq!(server_port_from(Some("not-a-port")), 3030);
        assert_eq!(server_port_from(None), 3030);
    }

    #[test]
    fn admission_config_requires_a_positive_integer() {
        assert_eq!(max_in_flight_from(None), Ok(routes::DEFAULT_MAX_IN_FLIGHT));
        assert_eq!(max_in_flight_from(Some("1")), Ok(1));
        assert_eq!(max_in_flight_from(Some(" 4 ")), Ok(4));
        // Rust's usize parser accepts a leading '+', matching its semantics.
        for invalid in ["0", "-2", "abc", "", "1.5"] {
            let error = max_in_flight_from(Some(invalid))
                .expect_err("invalid admission values must be rejected");
            assert!(
                error.contains("positive integer"),
                "unexpected error for '{invalid}': {error}"
            );
            assert!(
                error.contains(invalid),
                "error must quote the raw value for '{invalid}': {error}"
            );
        }
    }

    // ======================================================================
    // Admission gate coverage through the real middleware/router.
    // ======================================================================

    /// Shared registry letting tests control the blocking work started by the
    /// probe handlers below: the handler moves the entry's started-sender and
    /// release-receiver into the worker closure.
    type ProbeRegistry =
        Arc<Mutex<HashMap<String, (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>>;
    fn probe_registry() -> ProbeRegistry {
        Arc::new(Mutex::new(HashMap::new()))
    }

    /// Bound on how long a probe worker may wait for its test-side release
    /// before giving up on its own, so a broken test cannot wedge runtime
    /// shutdown even without the session guard.
    const PROBE_RELEASE_TIMEOUT: Duration = Duration::from_secs(10);

    /// Test-side handles for one probe request. Dropping the session releases
    /// the worker, so an assertion failure during unwinding cannot leave a
    /// worker blocked on its release channel and hang runtime teardown.
    struct ProbeSession {
        started_rx: std::sync::mpsc::Receiver<()>,
        release_tx: std::sync::mpsc::Sender<()>,
    }

    impl ProbeSession {
        /// Wait until the probe worker signals it started, bounded so a
        /// broken pipeline fails the test instead of hanging it.
        fn wait_started(&self) {
            if self
                .started_rx
                .recv_timeout(Duration::from_secs(10))
                .is_err()
            {
                panic!("probe worker never started");
            }
        }

        fn release(&self) {
            // The worker may have timed out already; a failed send is fine.
            let _ = self.release_tx.send(());
        }
    }

    impl Drop for ProbeSession {
        fn drop(&mut self) {
            self.release();
        }
    }

    async fn probe_handler(
        Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
        Extension(semaphore): Extension<Arc<tokio::sync::Semaphore>>,
        State(registry): State<ProbeRegistry>,
        Json(req): Json<serde_json::Value>,
    ) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
        let id = req["id"].as_str().ok_or((
            StatusCode::BAD_REQUEST,
            "probe request needs an id".to_string(),
        ))?;
        let (started_tx, release_rx) = registry
            .lock()
            .expect("probe registry lock")
            .remove(id)
            .ok_or((StatusCode::NOT_FOUND, "unknown probe id".to_string()))?;
        let done = tokio::task::spawn_blocking(move || {
            // The permit clone must survive until the controlled work ends.
            let _admission_permit = admission_permit;
            started_tx.send(()).expect("probe started signal");
            if release_rx.recv_timeout(PROBE_RELEASE_TIMEOUT).is_err() {
                panic!("probe worker was never released; test cleanup failed");
            }
            serde_json::json!({ "done": true })
        })
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("probe worker failed: {error}"),
            )
        })?;
        // The worker reference is gone at this point, so any remaining
        // capacity must come from the middleware's own reference. If the
        // middleware dropped its permit after dispatch, this reads 1 with a
        // limit of 1 and the serialization-capacity regression fires.
        let available_permits_at_response = semaphore.available_permits();
        Ok(Json(serde_json::json!({
            "done": done,
            "availablePermitsAtResponse": available_permits_at_response,
        })))
    }

    async fn probe_error_handler(
        Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
    ) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
        // Validation failure after admission: capacity must still release.
        let _admission_permit = admission_permit;
        Err((
            StatusCode::BAD_REQUEST,
            "probe validation failure".to_string(),
        ))
    }

    async fn probe_panic_handler(
        Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
    ) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
        let result = tokio::task::spawn_blocking(move || {
            let _admission_permit = admission_permit;
            panic!("probe worker boom");
        })
        .await;
        Err(match result {
            Ok(value) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("probe unexpectedly succeeded: {value:?}"),
            ),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("probe worker failed: {error}"),
            ),
        })
    }

    fn probe_router(state: AppState, registry: ProbeRegistry) -> Router {
        // The router state is the probe registry; the admission gate carries
        // its own AppState via from_fn_with_state. Like the production
        // build_router, only the CPU-heavy probe routes pass the gate; the
        // health route stays outside it. The extension layer exposes the
        // shared semaphore to the probe handlers for capacity assertions.
        let admission = middleware::from_fn_with_state(state.clone(), admission_gate);
        Router::new()
            .route("/probe", post(probe_handler).route_layer(admission.clone()))
            .route(
                "/probe-error",
                post(probe_error_handler).route_layer(admission.clone()),
            )
            .route(
                "/probe-panic",
                post(probe_panic_handler).route_layer(admission),
            )
            .route("/api/health", get(health_check))
            .layer(Extension(Arc::clone(&state.max_in_flight)))
            .with_state(registry)
    }

    fn probe_registry_entry(registry: &ProbeRegistry, id: &str) -> ProbeSession {
        let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        registry
            .lock()
            .expect("probe registry lock")
            .insert(id.to_string(), (started_tx, release_rx));
        ProbeSession {
            started_rx,
            release_tx,
        }
    }

    async fn post_json_to(
        app: Router,
        uri: &str,
        body: serde_json::Value,
        origin: Option<&str>,
    ) -> Response {
        let mut builder = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        let request = builder
            .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
            .expect("test request should build");
        use tower::ServiceExt;
        app.oneshot(request).await.expect("router should answer")
    }

    async fn get_to(app: Router, uri: &str) -> Response {
        let request = axum::http::Request::builder()
            .method(axum::http::Method::GET)
            .uri(uri)
            .body(axum::body::Body::empty())
            .expect("test request should build");
        use tower::ServiceExt;
        app.oneshot(request).await.expect("router should answer")
    }

    async fn response_text(response: Response) -> String {
        let bytes = BodyExt::collect(response.into_body())
            .await
            .expect("body collects")
            .to_bytes();
        String::from_utf8(bytes.to_vec()).expect("utf-8 body")
    }

    fn test_cors() -> CorsLayer {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(cors_origins(None)))
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([header::CONTENT_TYPE])
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn admission_rejects_overload_before_parsing_and_keeps_health_open() {
        let state = AppState::new(1);
        // Saturate the single admission slot directly.
        let held = state
            .max_in_flight
            .clone()
            .try_acquire_owned()
            .expect("permit available");

        // Health is outside the gate.
        let response = get_to(probe_router(state.clone(), probe_registry()), "/api/health").await;
        assert_eq!(response.status(), StatusCode::OK);

        // Malformed JSON gets 503, proving rejection happens before parsing.
        let request = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/probe")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from("{not json"))
            .unwrap();
        {
            use tower::ServiceExt;
            let response = probe_router(state.clone(), probe_registry())
                .oneshot(request)
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let text = response_text(response).await;
            assert!(text.contains("Engine busy"), "unexpected body: {text}");
        }

        // The real production router behaves identically, and the 503 keeps
        // its CORS headers so browser callers can read the failure.
        let production = build_router(state.clone(), test_cors());
        let request = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/api/backtest")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, "http://localhost:5173")
            .body(axum::body::Body::from("{not json"))
            .unwrap();
        {
            use tower::ServiceExt;
            let response = production.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .and_then(|value| value.to_str().ok()),
                Some("http://localhost:5173")
            );
        }

        drop(held);
        assert_eq!(state.max_in_flight.available_permits(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn admission_capacity_is_held_until_the_worker_settles() {
        let state = AppState::new(1);
        let registry = probe_registry();
        // Dropping the session releases the worker even if an assertion
        // below fails.
        let worker_a = probe_registry_entry(&registry, "worker-a");

        let app = probe_router(state.clone(), Arc::clone(&registry));
        let request = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/probe")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                serde_json::to_vec(&serde_json::json!({ "id": "worker-a" })).unwrap(),
            ))
            .unwrap();
        let task = tokio::spawn(async move {
            use tower::ServiceExt;
            app.oneshot(request).await.expect("probe response")
        });

        worker_a.wait_started();
        // The middleware and the blocking worker both hold references.
        assert_eq!(
            state.max_in_flight.available_permits(),
            0,
            "capacity must be held while the CPU work runs"
        );

        worker_a.release();
        let response = task.await.expect("probe task joins");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            state.max_in_flight.available_permits(),
            1,
            "capacity must return after completion"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn admission_capacity_is_held_through_response_serialization() {
        let state = AppState::new(1);
        let registry = probe_registry();
        let serialize_a = probe_registry_entry(&registry, "serialize-a");

        let app = probe_router(state.clone(), registry);
        let request = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/probe")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                serde_json::to_vec(&serde_json::json!({ "id": "serialize-a" })).unwrap(),
            ))
            .unwrap();
        let task = tokio::spawn(async move {
            use tower::ServiceExt;
            app.oneshot(request).await.expect("probe response")
        });

        serialize_a.wait_started();
        assert_eq!(
            state.max_in_flight.available_permits(),
            0,
            "capacity must be held while the CPU work runs"
        );

        serialize_a.release();
        let response = task.await.expect("probe task joins");
        assert_eq!(response.status(), StatusCode::OK);
        let text = response_text(response).await;
        let body: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            body["availablePermitsAtResponse"], 0,
            "the middleware must retain its permit through response              construction; the worker reference alone freed capacity before              serialization"
        );
        assert_eq!(
            state.max_in_flight.available_permits(),
            1,
            "capacity must return once the response is built"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn disconnect_retains_capacity_until_the_worker_settles() {
        let state = AppState::new(1);
        let registry = probe_registry();
        let worker_b = probe_registry_entry(&registry, "worker-b");

        let app = probe_router(state.clone(), Arc::clone(&registry));
        let request = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/probe")
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                serde_json::to_vec(&serde_json::json!({ "id": "worker-b" })).unwrap(),
            ))
            .unwrap();
        let task = tokio::spawn(async move {
            use tower::ServiceExt;
            app.oneshot(request).await.expect("probe response")
        });

        worker_b.wait_started();
        // Simulate a disconnect: drop the in-flight response future while the
        // worker keeps computing.
        task.abort();

        assert_eq!(
            state.max_in_flight.available_permits(),
            0,
            "the worker still owns its permit clone after a disconnect"
        );

        worker_b.release();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while state.max_in_flight.available_permits() < 1 {
            assert!(
                std::time::Instant::now() < deadline,
                "capacity never returned after the worker settled"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(state.max_in_flight.available_permits(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn completion_error_and_panic_paths_release_capacity() {
        let state = AppState::new(1);

        // /probe-error answers with its own validation status; /probe-panic
        // surfaces the failed worker join. Both must release capacity.
        let expected_status = [("/probe-error", 400_u16), ("/probe-panic", 500)];
        for (uri, expected_status) in expected_status {
            let response = post_json_to(
                probe_router(state.clone(), probe_registry()),
                uri,
                serde_json::json!({}),
                None,
            )
            .await;
            assert_eq!(
                response.status().as_u16(),
                expected_status,
                "{uri} must answer with its own failure status"
            );
            assert_eq!(
                state.max_in_flight.available_permits(),
                1,
                "{uri} must release admission capacity"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn protected_production_routes_accept_and_admit_normally() {
        let state = AppState::new(1);
        let app = build_router(state.clone(), test_cors());

        // Upload a tiny dataset: admitted, then the cached batch runs too.
        let response = post_json_to(
            app.clone(),
            "/api/data/cache",
            serde_json::json!({
                "data": [
                    {"time": 0, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1000.0},
                    {"time": 60000, "open": 105.0, "high": 106.0, "low": 104.0, "close": 105.0, "volume": 1000.0},
                    {"time": 120000, "open": 105.0, "high": 106.0, "low": 104.0, "close": 105.0, "volume": 1000.0}
                ]
            }),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = response_text(response).await;
        let upload: serde_json::Value = serde_json::from_str(&text).unwrap();
        let cache_id = upload["cacheId"].as_str().unwrap().to_string();

        let response = post_json_to(
            app.clone(),
            "/api/backtest/batch/cached",
            serde_json::json!({
                "cacheId": cache_id,
                "items": [{
                    "id": "candidate-1",
                    "signals": [
                        {"time": 0, "type": "buy", "price": 100.0},
                        {"time": 60000, "type": "sell", "price": 105.0}
                    ]
                }],
                "initialCapital": 10000.0,
                "positionSizePercent": 100.0,
                "commissionPercent": 0.0
            }),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = response_text(response).await;
        let batch: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(batch["results"][0]["result"]["totalTrades"], 1);
        assert_eq!(
            state.max_in_flight.available_permits(),
            1,
            "capacity must return after both admitted requests complete"
        );
    }

    // ======================================================================
    // Structured log capture for admission diagnostics. Mirrors the helper
    // in routes.rs tests: one global subscriber feeds a shared buffer, and
    // capture tests serialize on an async mutex.
    // ======================================================================

    #[derive(Clone, Default)]
    struct SharedLogBuffer(Arc<std::sync::Mutex<Vec<String>>>);

    struct CaptureWriter {
        shared: Arc<std::sync::Mutex<Vec<String>>>,
        line: Vec<u8>,
    }
    impl std::io::Write for CaptureWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.line.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for CaptureWriter {
        fn drop(&mut self) {
            if self.line.is_empty() {
                return;
            }
            let text = String::from_utf8_lossy(&self.line).trim_end().to_string();
            self.shared.lock().expect("log buffer lock").push(text);
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedLogBuffer {
        type Writer = CaptureWriter;
        fn make_writer(&'a self) -> CaptureWriter {
            CaptureWriter {
                shared: self.0.clone(),
                line: Vec::new(),
            }
        }
    }

    fn shared_log_buffer() -> Arc<std::sync::Mutex<Vec<String>>> {
        static BUFFER: std::sync::OnceLock<Arc<std::sync::Mutex<Vec<String>>>> =
            std::sync::OnceLock::new();
        BUFFER
            .get_or_init(|| Arc::new(std::sync::Mutex::default()))
            .clone()
    }

    fn init_log_capture() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let subscriber = tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer(SharedLogBuffer(shared_log_buffer()))
                .finish();
            let _ = tracing::subscriber::set_global_default(subscriber);
        });
    }

    async fn log_capture_lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(tokio::sync::Mutex::default).lock().await
    }

    fn records_containing(marker: &str) -> Vec<String> {
        shared_log_buffer()
            .lock()
            .expect("log buffer lock")
            .iter()
            .filter(|record| record.contains(marker))
            .cloned()
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn overload_rejection_emits_a_structured_event() {
        init_log_capture();
        let _guard = log_capture_lock().await;

        let state = AppState::new(1);
        let held = state
            .max_in_flight
            .clone()
            .try_acquire_owned()
            .expect("permit available");

        let response = post_json_to(
            probe_router(state.clone(), probe_registry()),
            "/probe",
            serde_json::json!({ "id": "never-looked-up" }),
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        drop(held);
        let records = records_containing("admission rejected");
        assert!(
            records.iter().any(|record| {
                record.contains("request_id=")
                    && record.contains("route=/probe")
                    && record.contains("limit=1")
            }),
            "overload rejection event missing or missing fields: {records:?}"
        );
    }

    #[test]
    fn default_admission_state_uses_the_conservative_default() {
        let state = AppState::default();
        assert_eq!(
            state.max_in_flight.available_permits(),
            routes::DEFAULT_MAX_IN_FLIGHT
        );
        assert_eq!(routes::DEFAULT_MAX_IN_FLIGHT, 2);
    }
}
