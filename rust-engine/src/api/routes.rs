//! API Routes and Handlers
use crate::backtest::{build_market_series, run_backtest_with_market_series_options};
use crate::types::{
    BacktestRequest, BacktestResult, BatchBacktestRequest, BatchBacktestResponse,
    BatchBacktestResultItem, Time, OHLCV,
};
use axum::{extract::State, http::StatusCode, Json};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::RwLock;
const MAX_DATA_CACHE_ENTRIES: usize = 512;
const MAX_DATA_CACHE_BARS: usize = 16_000_000;
// ============================================================================
// Data Cache Types
// ============================================================================
pub struct CachedDataset {
    data: Arc<Vec<OHLCV>>,
    last_access: u64,
}

/// Shared application state containing the OHLCV data cache
#[derive(Clone)]
pub struct AppState {
    /// Cache of OHLCV data indexed by hash
    pub data_cache: Arc<RwLock<HashMap<String, CachedDataset>>>,
    cache_access_counter: Arc<AtomicU64>,
}
impl Default for AppState {
    fn default() -> Self {
        Self {
            data_cache: Arc::new(RwLock::new(HashMap::new())),
            cache_access_counter: Arc::new(AtomicU64::new(0)),
        }
    }
}
/// Request to cache OHLCV data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDataRequest {
    #[serde(default)]
    pub data: Vec<OHLCV>,
    #[serde(default)]
    pub packed_data: Option<Vec<f64>>,
}
/// Response after caching OHLCV data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheDataResponse {
    pub cache_id: String,
    pub bar_count: usize,
}
/// Batch backtest request using cached data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedBatchBacktestRequest {
    /// Cache ID referencing previously uploaded OHLCV data
    pub cache_id: String,
    /// List of signal sets to backtest
    pub items: Vec<crate::types::BatchBacktestItem>,
    pub initial_capital: f64,
    pub position_size_percent: f64,
    pub commission_percent: f64,
    #[serde(default)]
    pub base_settings: crate::types::BacktestSettings,
    #[serde(default)]
    pub sizing: crate::types::TradeSizingConfig,
    /// When true, omit drawdown calculation from compact results.
    #[serde(default)]
    pub skip_drawdown: bool,
    /// When true, omit Sharpe ratio calculation from compact results.
    #[serde(default)]
    pub skip_sharpe_ratio: bool,
    /// When true, omit heavy payloads (trades, equity curve) from results
    #[serde(default)]
    pub compact: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestResponse {
    #[serde(flatten)]
    result: BacktestResult,
    processing_time_ms: u64,
}
// ============================================================================
// Handlers
// ============================================================================
async fn run_on_blocking_pool<F, T>(work: F) -> Result<T, (StatusCode, String)>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        tracing::error!("CPU-bound backtest task failed: {}", error);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Backtest worker task failed: {error}"),
        )
    })
}
/// Reject batch items that carry the legacy `packedSignals` field. The engine
/// never implemented packed execution, and silently running such items
/// produced plausible-looking zero-trade results. The whole request is
/// rejected before cache lookup or CPU dispatch; ordinary empty signals stay
/// a valid no-trade candidate.
fn reject_unsupported_packed_signals(
    items: &[crate::types::BatchBacktestItem],
) -> Result<(), (StatusCode, String)> {
    for item in items {
        if item.packed_signals.is_some() {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "Batch item '{}' uses packedSignals, which this engine does not support; send plain signals instead",
                    item.id
                ),
            ));
        }
    }
    Ok(())
}
/// Handle backtest request
pub async fn backtest_handler(
    Json(req): Json<BacktestRequest>,
) -> Result<Json<BacktestResponse>, (StatusCode, String)> {
    let start = Instant::now();
    let result = run_on_blocking_pool(move || {
        let market_series = build_market_series(&req.data);
        run_backtest_with_market_series_options(
            &req.data,
            &req.signals,
            req.initial_capital,
            req.position_size_percent,
            req.commission_percent,
            &req.settings,
            Some(&req.sizing),
            req.compact,
            req.retain_trades,
            req.skip_drawdown,
            req.skip_sharpe_ratio,
            &market_series,
        )
    })
    .await?;
    Ok(Json(BacktestResponse {
        result,
        processing_time_ms: start.elapsed().as_millis() as u64,
    }))
}
/// Handle batch backtest request - runs multiple backtests in parallel
pub async fn batch_backtest_handler(
    Json(req): Json<BatchBacktestRequest>,
) -> Result<Json<BatchBacktestResponse>, (StatusCode, String)> {
    reject_unsupported_packed_signals(&req.items)?;
    let response = run_on_blocking_pool(move || {
        let start = Instant::now();
        let market_series = build_market_series(&req.data);
        // Run all backtests in parallel using rayon.
        let results: Vec<BatchBacktestResultItem> = req
            .items
            .par_iter()
            .map(|item| {
                // Use item-specific settings if provided, otherwise use base settings
                let settings = item
                    .settings
                    .clone()
                    .unwrap_or_else(|| req.base_settings.clone());
                let result = run_backtest_with_market_series_options(
                    &req.data,
                    &item.signals,
                    req.initial_capital,
                    req.position_size_percent,
                    req.commission_percent,
                    &settings,
                    Some(&req.sizing),
                    req.compact,
                    false,
                    req.skip_drawdown,
                    req.skip_sharpe_ratio,
                    &market_series,
                );
                BatchBacktestResultItem {
                    id: item.id.clone(),
                    result,
                }
            })
            .collect();
        let processing_time_ms = start.elapsed().as_millis() as u64;
        BatchBacktestResponse {
            results,
            processing_time_ms,
        }
    })
    .await?;
    Ok(Json(response))
}
/// Cache OHLCV data and return a cache ID
/// This allows sending large datasets once and referencing them by ID
pub async fn cache_data_handler(
    State(state): State<AppState>,
    Json(req): Json<CacheDataRequest>,
) -> Result<Json<CacheDataResponse>, (StatusCode, String)> {
    // The cache ID must distinguish assets with the same time range and bar
    // count. Asset Opportunity commonly uploads many synthetic datasets that
    // share both, so a range-only key can silently run a candidate against the
    // wrong asset.
    let data = if !req.data.is_empty() {
        req.data
    } else if let Some(packed_data) = req.packed_data {
        match decode_packed_ohlcv(packed_data) {
            Ok(data) => data,
            Err(message) => return Err((StatusCode::BAD_REQUEST, message)),
        }
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            "Cache request has no data".to_string(),
        ));
    };
    let bar_count = data.len();
    let cache_id = cache_id_for_data(&data);
    // Store in cache
    {
        let mut cache = state.data_cache.write().await;
        cache.insert(
            cache_id.clone(),
            CachedDataset {
                data: Arc::new(data),
                last_access: next_cache_access(&state),
            },
        );
        // Keep a bounded working set for repeated batch requests.
        trim_data_cache(&mut cache);
    }
    tracing::info!("Cached {} bars with ID: {}", bar_count, cache_id);
    Ok(Json(CacheDataResponse {
        cache_id,
        bar_count,
    }))
}
fn cache_id_for_data(data: &[OHLCV]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    data.len().hash(&mut hasher);
    for bar in data {
        bar.time.hash(&mut hasher);
        bar.open.to_bits().hash(&mut hasher);
        bar.high.to_bits().hash(&mut hasher);
        bar.low.to_bits().hash(&mut hasher);
        bar.close.to_bits().hash(&mut hasher);
        bar.volume.to_bits().hash(&mut hasher);
    }
    format!("{:x}", hasher.finish())
}
fn next_cache_access(state: &AppState) -> u64 {
    state.cache_access_counter.fetch_add(1, Ordering::Relaxed)
}

async fn get_cached_dataset(state: &AppState, cache_id: &str) -> Option<Arc<Vec<OHLCV>>> {
    let mut cache = state.data_cache.write().await;
    let access = next_cache_access(state);
    let entry = cache.get_mut(cache_id)?;
    entry.last_access = access;
    Some(entry.data.clone())
}

fn trim_data_cache(cache: &mut HashMap<String, CachedDataset>) {
    while cache.len() > MAX_DATA_CACHE_ENTRIES
        || cache.values().map(|entry| entry.data.len()).sum::<usize>() > MAX_DATA_CACHE_BARS
    {
        let lru_key = cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_access)
            .map(|(key, _)| key.clone());
        if let Some(key) = lru_key {
            cache.remove(&key);
        } else {
            break;
        }
    }
}
fn decode_packed_ohlcv(values: Vec<f64>) -> Result<Vec<OHLCV>, String> {
    if !values.len().is_multiple_of(6) {
        return Err("Packed OHLCV data length must be divisible by 6".to_string());
    }
    let mut data = Vec::with_capacity(values.len() / 6);
    for row in values.as_chunks::<6>().0 {
        if !row.iter().all(|value| value.is_finite()) {
            return Err("Packed OHLCV data contains a non-finite value".to_string());
        }
        data.push(OHLCV::new(
            row[0] as Time,
            row[1],
            row[2],
            row[3],
            row[4],
            row[5],
        ));
    }
    if data.is_empty() {
        return Err("Packed OHLCV data must not be empty".to_string());
    }
    Ok(data)
}
/// Handle batch backtest using cached OHLCV data
/// This is MUCH faster for large datasets as data is only sent once
pub async fn cached_batch_backtest_handler(
    State(state): State<AppState>,
    Json(req): Json<CachedBatchBacktestRequest>,
) -> Result<Json<BatchBacktestResponse>, (StatusCode, String)> {
    // Validate before touching the cache so unsupported requests never hit
    // simulation or dispatch.
    reject_unsupported_packed_signals(&req.items)?;
    let start = Instant::now();
    // Get cached data
    let data = get_cached_dataset(&state, &req.cache_id).await;
    let data = match data {
        Some(d) => d,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                format!(
                    "Cache ID '{}' not found. Upload data first via /api/data/cache",
                    req.cache_id
                ),
            ));
        }
    };
    tracing::debug!(
        "Running batch backtest with {} items against {} cached bars",
        req.items.len(),
        data.len()
    );
    let response = run_on_blocking_pool(move || {
        let market_series = build_market_series(data.as_slice());
        // Run all backtests in parallel using rayon.
        let results: Vec<BatchBacktestResultItem> = req
            .items
            .par_iter()
            .map(|item| {
                let settings = item
                    .settings
                    .clone()
                    .unwrap_or_else(|| req.base_settings.clone());
                let result = run_backtest_with_market_series_options(
                    data.as_slice(),
                    &item.signals,
                    req.initial_capital,
                    req.position_size_percent,
                    req.commission_percent,
                    &settings,
                    Some(&req.sizing),
                    req.compact,
                    false,
                    req.skip_drawdown,
                    req.skip_sharpe_ratio,
                    &market_series,
                );
                BatchBacktestResultItem {
                    id: item.id.clone(),
                    result,
                }
            })
            .collect();
        let processing_time_ms = start.elapsed().as_millis() as u64;
        BatchBacktestResponse {
            results,
            processing_time_ms,
        }
    })
    .await?;
    tracing::info!(
        "Cached batch backtest: {} runs in {}ms",
        response.results.len(),
        response.processing_time_ms
    );
    Ok(Json(response))
}
/// Clear data cache
pub async fn clear_cache_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut cache = state.data_cache.write().await;
    let count = cache.len();
    cache.clear();
    tracing::info!("Cleared {} cached datasets", count);
    Json(serde_json::json!({
        "cleared": count,
        "status": "ok"
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Signal;

    fn make_backtest_request(compact: bool, retain_trades: bool) -> BacktestRequest {
        BacktestRequest {
            data: vec![
                OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
                OHLCV::new(60000, 105.0, 106.0, 104.0, 105.0, 1000.0),
                OHLCV::new(120000, 105.0, 106.0, 104.0, 105.0, 1000.0),
            ],
            signals: vec![Signal::buy(0, 100.0), Signal::sell(60000, 105.0)],
            initial_capital: 10000.0,
            position_size_percent: 100.0,
            commission_percent: 0.0,
            settings: crate::types::BacktestSettings::default(),
            sizing: crate::types::TradeSizingConfig::default(),
            compact,
            retain_trades,
            skip_drawdown: false,
            skip_sharpe_ratio: false,
        }
    }

    #[tokio::test]
    async fn generic_backtest_route_honors_output_options() {
        let full = backtest_handler(Json(make_backtest_request(false, false)))
            .await
            .expect("generic backtest worker should complete")
            .0
            .result;
        assert!(!full.equity_curve.is_empty());
        assert_eq!(full.trades.len(), 1);

        let compact = backtest_handler(Json(make_backtest_request(true, false)))
            .await
            .expect("generic compact backtest worker should complete")
            .0
            .result;
        assert!(compact.equity_curve.is_empty());
        assert!(compact.trades.is_empty());
        assert_eq!(compact.total_trades, full.total_trades);

        let compact_with_trades = backtest_handler(Json(make_backtest_request(true, true)))
            .await
            .expect("generic compact trade backtest worker should complete")
            .0
            .result;
        assert!(compact_with_trades.equity_curve.is_empty());
        assert_eq!(compact_with_trades.trades.len(), 1);
        assert_eq!(compact_with_trades.total_trades, full.total_trades);
    }

    #[tokio::test]
    async fn batch_backtest_route_preserves_item_results_after_offload() {
        let request = make_backtest_request(false, false);
        let response = batch_backtest_handler(Json(BatchBacktestRequest {
            data: request.data,
            items: vec![crate::types::BatchBacktestItem {
                id: "candidate-1".to_string(),
                signals: request.signals,
                packed_signals: None,
                settings: None,
            }],
            initial_capital: request.initial_capital,
            position_size_percent: request.position_size_percent,
            commission_percent: request.commission_percent,
            base_settings: request.settings,
            sizing: request.sizing,
            compact: request.compact,
            skip_drawdown: false,
            skip_sharpe_ratio: false,
        }))
        .await
        .expect("batch worker should complete")
        .0;

        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].id, "candidate-1");
        assert_eq!(response.results[0].result.total_trades, 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_pool_runner_uses_a_worker_thread() {
        let executor_thread = std::thread::current().id();
        let worker_thread = run_on_blocking_pool(|| std::thread::current().id())
            .await
            .expect("blocking worker should complete");

        assert_ne!(executor_thread, worker_thread);
    }

    #[test]
    fn data_cache_evicts_the_least_recently_used_dataset() {
        let mut cache = HashMap::with_capacity(MAX_DATA_CACHE_ENTRIES + 1);
        cache.insert(
            "oldest".to_string(),
            CachedDataset {
                data: Arc::new(Vec::new()),
                last_access: 0,
            },
        );
        for index in 0..MAX_DATA_CACHE_ENTRIES {
            cache.insert(
                format!("dataset-{index}"),
                CachedDataset {
                    data: Arc::new(Vec::new()),
                    last_access: index as u64 + 1,
                },
            );
        }

        trim_data_cache(&mut cache);

        assert_eq!(cache.len(), MAX_DATA_CACHE_ENTRIES);
        assert!(!cache.contains_key("oldest"));
    }

    fn batch_request_payload(packed_signals: Option<serde_json::Value>) -> serde_json::Value {
        let mut item = serde_json::json!({
            "id": "candidate-packed",
            "signals": [
                {"time": 0, "type": "buy", "price": 100.0},
                {"time": 60000, "type": "sell", "price": 105.0}
            ],
        });
        if let Some(packed) = packed_signals {
            item["packedSignals"] = packed;
        }
        serde_json::json!({
            "data": [
                {"time": 0, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1000.0},
                {"time": 60000, "open": 105.0, "high": 106.0, "low": 104.0, "close": 105.0, "volume": 1000.0},
                {"time": 120000, "open": 105.0, "high": 106.0, "low": 104.0, "close": 105.0, "volume": 1000.0}
            ],
            "items": [item],
            "initialCapital": 10000.0,
            "positionSizePercent": 100.0,
            "commissionPercent": 0.0
        })
    }

    const fn packed_rejection_message() -> &'static str {
        "packedSignals"
    }

    #[tokio::test]
    async fn batch_route_rejects_packed_signal_items() {
        for packed in [
            serde_json::json!([0.0, 0.0, 100.0, 0.0]),
            serde_json::json!([]),
        ] {
            let mut payload = batch_request_payload(None);
            payload["items"][0]["packedSignals"] = packed;
            let request: BatchBacktestRequest =
                serde_json::from_value(payload).expect("camelCase batch payload must deserialize");
            let error = batch_backtest_handler(Json(request))
                .await
                .expect_err("packed items must be rejected");
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
            assert!(error.1.contains(packed_rejection_message()));
        }

        // Without the field, the ordinary signals keep their results.
        let request: BatchBacktestRequest =
            serde_json::from_value(batch_request_payload(None)).unwrap();
        let response = batch_backtest_handler(Json(request))
            .await
            .expect("ordinary batch should complete")
            .0;
        assert_eq!(response.results[0].result.total_trades, 1);
    }

    #[tokio::test]
    async fn cached_batch_route_rejects_packed_items_before_cache_lookup() {
        let state = AppState::default();
        // A packed request with a cache ID that was never uploaded must fail
        // validation, not report a missing cache entry.
        let mut payload = batch_request_payload(None);
        payload["cacheId"] = serde_json::json!("never-uploaded");
        payload["items"][0]["packedSignals"] = serde_json::json!([]);
        let request: CachedBatchBacktestRequest = serde_json::from_value(payload).unwrap();
        let error = cached_batch_backtest_handler(State(state.clone()), Json(request))
            .await
            .expect_err("packed items must be rejected before cache lookup");
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(error.1.contains(packed_rejection_message()));

        // Invalid cached IDs still report NOT_FOUND for ordinary requests.
        let mut payload = batch_request_payload(None);
        payload["cacheId"] = serde_json::json!("never-uploaded");
        let request: CachedBatchBacktestRequest = serde_json::from_value(payload).unwrap();
        let error = cached_batch_backtest_handler(State(state), Json(request))
            .await
            .expect_err("unknown cache id must 404");
        assert_eq!(error.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cached_batch_route_runs_ordinary_items_after_upload() {
        let state = AppState::default();
        let upload = cache_data_handler(
            State(state.clone()),
            Json(CacheDataRequest {
                data: vec![
                    OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
                    OHLCV::new(60000, 105.0, 106.0, 104.0, 105.0, 1000.0),
                    OHLCV::new(120000, 105.0, 106.0, 104.0, 105.0, 1000.0),
                ],
                packed_data: None,
            }),
        )
        .await
        .expect("upload should succeed")
        .0;
        let cache_id = upload.cache_id;

        let payload = serde_json::json!({
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
        });
        let request: CachedBatchBacktestRequest = serde_json::from_value(payload).unwrap();
        let response = cached_batch_backtest_handler(State(state), Json(request))
            .await
            .expect("cached batch should complete")
            .0;
        assert_eq!(response.results[0].id, "candidate-1");
        assert_eq!(response.results[0].result.total_trades, 1);
    }

    async fn post_json(
        app: axum::Router,
        uri: &str,
        payload: serde_json::Value,
    ) -> axum::http::Response<axum::body::Body> {
        use tower::ServiceExt;
        let request = axum::http::Request::builder()
            .method(axum::http::Method::POST)
            .uri(uri)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                serde_json::to_vec(&payload).unwrap(),
            ))
            .expect("test request should build");
        app.oneshot(request).await.expect("router should answer")
    }

    async fn response_body_text(response: axum::http::Response<axum::body::Body>) -> String {
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .expect("response body should collect")
            .to_bytes();
        String::from_utf8(bytes.to_vec()).expect("response body should be utf-8")
    }

    fn batch_test_router(state: AppState) -> axum::Router {
        axum::Router::new()
            .route(
                "/api/backtest/batch",
                axum::routing::post(batch_backtest_handler),
            )
            .route(
                "/api/backtest/batch/cached",
                axum::routing::post(cached_batch_backtest_handler),
            )
            .with_state(state)
    }

    #[tokio::test]
    async fn http_layer_preserves_packed_rejection_and_ordinary_success() {
        let app = batch_test_router(AppState::default());

        let mut packed_payload = batch_request_payload(None);
        packed_payload["items"][0]["packedSignals"] = serde_json::json!([1.0, 0.0, 100.0, 3.0]);
        let response = post_json(app.clone(), "/api/backtest/batch", packed_payload).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let text = response_body_text(response).await;
        assert!(text.contains(packed_rejection_message()));

        let response = post_json(app, "/api/backtest/batch", batch_request_payload(None)).await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = response_body_text(response).await;
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["results"][0]["result"]["totalTrades"], 1);
        assert!(parsed["processingTimeMs"].is_u64());
    }
}
