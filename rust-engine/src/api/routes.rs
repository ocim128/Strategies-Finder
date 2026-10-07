//! API Routes and Handlers
use crate::backtest::{build_market_series, run_backtest_with_market_series_options};
use crate::types::{
    BacktestRequest, BacktestResult, BatchBacktestRequest, BatchBacktestResponse,
    BatchBacktestResultItem, Time, OHLCV,
};
use axum::{extract::Extension, extract::State, http::StatusCode, Json};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
const MAX_DATA_CACHE_ENTRIES: usize = 512;
const MAX_DATA_CACHE_BARS: usize = 16_000_000;
/// Conservative starting admission bound for CPU-heavy routes. This is an
/// evaluation default, not a validated product setting: before rollout,
/// concurrent Finder runs must compare limits of 2 and 4 against the
/// pre-admission behavior, measuring total duration, TypeScript fallback
/// count, repeated cache uploads, and peak RSS. The
/// `RUST_ENGINE_MAX_IN_FLIGHT` setting overrides it at startup.
pub const DEFAULT_MAX_IN_FLIGHT: usize = 2;
/// Per-request identifier assigned by the admission middleware and carried
/// into request spans so concurrent requests have distinguishable log
/// records, including rejections.
#[derive(Debug, Clone, Copy)]
pub struct RequestId(pub u64);
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
    /// Admission bound shared by every CPU-heavy route.
    pub max_in_flight: Arc<Semaphore>,
    /// The configured admission limit, kept for structured diagnostics.
    max_in_flight_limit: usize,
    request_counter: Arc<AtomicU64>,
}
impl AppState {
    pub fn new(max_in_flight: usize) -> Self {
        Self {
            data_cache: Arc::new(RwLock::new(HashMap::new())),
            cache_access_counter: Arc::new(AtomicU64::new(0)),
            max_in_flight: Arc::new(Semaphore::new(max_in_flight)),
            max_in_flight_limit: max_in_flight,
            request_counter: Arc::new(AtomicU64::new(0)),
        }
    }
    /// The configured admission limit, for diagnostic events.
    pub fn max_in_flight_limit(&self) -> usize {
        self.max_in_flight_limit
    }
    /// Monotonic per-process request identifier for log correlation.
    pub fn next_request_id(&self) -> u64 {
        self.request_counter.fetch_add(1, Ordering::Relaxed) + 1
    }
}
impl Default for AppState {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_IN_FLIGHT)
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
/// Diagnostic stage timings for one blocking worker invocation. These values
/// feed structured logs only; the wire contract stays untouched.
#[derive(Debug, Default, Clone, Copy)]
struct WorkerStageTimings {
    /// Milliseconds from dispatch until the blocking worker picked up the
    /// closure, i.e. the blocking-pool queue wait.
    pool_wait_ms: u64,
    /// Milliseconds spent constructing the market series view. With lazy
    /// columns this constructor is allocation-free; deferred column
    /// materialization shows up under the simulation stage.
    market_prep_ms: u64,
    /// Wall time of the simulation work itself.
    simulate_ms: u64,
}
fn elapsed_ms_since(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}
// ============================================================================
// Handlers
// ============================================================================
/// Run CPU-heavy work on the blocking pool. Returns the work result plus the
/// pool-wait milliseconds measured from dispatch until the worker started.
async fn run_on_blocking_pool<F, T>(work: F) -> Result<(T, u64), (StatusCode, String)>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let dispatched_at = Instant::now();
    let result = tokio::task::spawn_blocking(move || {
        let pool_wait_ms = elapsed_ms_since(dispatched_at);
        (work(), pool_wait_ms)
    })
    .await
    .map_err(|error| {
        tracing::error!("CPU-bound task failed: {}", error);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("CPU-bound worker task failed: {error}"),
        )
    })?;
    Ok(result)
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
    Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
    request_id: Option<Extension<RequestId>>,
    Json(req): Json<BacktestRequest>,
) -> Result<Json<BacktestResponse>, (StatusCode, String)> {
    // Handler elapsed time starts immediately after successful JSON
    // extraction and stops at result assembly, so extraction, middleware,
    // serialization, and network time stay outside `processingTimeMs`.
    let start = Instant::now();
    let span = tracing::info_span!(
        "backtest_single",
        request_id = request_id.map(|Extension(id)| id.0).unwrap_or(0),
        route = "/api/backtest",
        bars = req.data.len(),
        compact = req.compact,
        skip_drawdown = req.skip_drawdown,
        skip_sharpe_ratio = req.skip_sharpe_ratio,
    );
    let completion_span = span.clone();
    let worker = run_on_blocking_pool(move || {
        // Retain admission capacity through computation: a disconnected
        // client must not free the slot while CPU work still runs.
        let _admission_permit = admission_permit;
        // Enter the request span only inside the synchronous closure so the
        // guard never spans an `.await`.
        let _entered = span.enter();
        let prep_started = Instant::now();
        let market_series = build_market_series(&req.data);
        let market_prep_ms = elapsed_ms_since(prep_started);
        let simulate_started = Instant::now();
        let result = run_backtest_with_market_series_options(
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
        );
        let simulate_ms = elapsed_ms_since(simulate_started);
        (result, market_prep_ms, simulate_ms)
    })
    .await;
    let ((result, market_prep_ms, simulate_ms), pool_wait_ms) = match worker {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(
                parent: &completion_span,
                status = error.0.as_u16(),
                error = %error.1,
                "blocking worker failed"
            );
            return Err(error);
        }
    };
    let processing_time_ms = elapsed_ms_since(start);
    let timings = WorkerStageTimings {
        pool_wait_ms,
        market_prep_ms,
        simulate_ms,
    };
    tracing::info!(
        parent: &completion_span,
        pool_wait_ms = timings.pool_wait_ms,
        market_prep_ms = timings.market_prep_ms,
        simulate_ms = timings.simulate_ms,
        total_ms = processing_time_ms,
        "backtest complete"
    );
    Ok(Json(BacktestResponse {
        result,
        processing_time_ms,
    }))
}
/// Handle batch backtest request - runs multiple backtests in parallel
pub async fn batch_backtest_handler(
    Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
    request_id: Option<Extension<RequestId>>,
    Json(req): Json<BatchBacktestRequest>,
) -> Result<Json<BatchBacktestResponse>, (StatusCode, String)> {
    let span = tracing::info_span!(
        "backtest_batch",
        request_id = request_id.map(|Extension(id)| id.0).unwrap_or(0),
        route = "/api/backtest/batch",
        bars = req.data.len(),
        items = req.items.len(),
        compact = req.compact,
        skip_drawdown = req.skip_drawdown,
        skip_sharpe_ratio = req.skip_sharpe_ratio,
    );
    if let Err(error) = reject_unsupported_packed_signals(&req.items) {
        tracing::warn!(
            parent: &span,
            status = error.0.as_u16(),
            error = %error.1,
            "batch rejected"
        );
        return Err(error);
    }
    // The clock covers pool wait and the whole simulation, matching the
    // single and cached-batch endpoints. Validation above is intentionally
    // outside the measurement.
    let start = Instant::now();
    let completion_span = span.clone();
    let worker = run_on_blocking_pool(move || {
        let _admission_permit = admission_permit;
        let _entered = span.enter();
        let prep_started = Instant::now();
        let market_series = build_market_series(&req.data);
        let market_prep_ms = elapsed_ms_since(prep_started);
        let simulate_started = Instant::now();
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
        let simulate_ms = elapsed_ms_since(simulate_started);
        let response = BatchBacktestResponse {
            results,
            processing_time_ms: 0,
        };
        (response, market_prep_ms, simulate_ms)
    })
    .await;
    let ((mut response, market_prep_ms, simulate_ms), pool_wait_ms) = match worker {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(
                parent: &completion_span,
                status = error.0.as_u16(),
                error = %error.1,
                "blocking worker failed"
            );
            return Err(error);
        }
    };
    // The reported batch timing includes the blocking-pool wait, so it is
    // stamped only after the worker completes.
    response.processing_time_ms = elapsed_ms_since(start);
    let timings = WorkerStageTimings {
        pool_wait_ms,
        market_prep_ms,
        simulate_ms,
    };
    tracing::info!(
        parent: &completion_span,
        pool_wait_ms = timings.pool_wait_ms,
        market_prep_ms = timings.market_prep_ms,
        simulate_ms = timings.simulate_ms,
        total_ms = response.processing_time_ms,
        "batch backtest complete"
    );
    Ok(Json(response))
}
/// Cache OHLCV data and return a cache ID
/// This allows sending large datasets once and referencing them by ID
pub async fn cache_data_handler(
    Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
    request_id: Option<Extension<RequestId>>,
    State(state): State<AppState>,
    Json(req): Json<CacheDataRequest>,
) -> Result<Json<CacheDataResponse>, (StatusCode, String)> {
    let start = Instant::now();
    let span = tracing::info_span!(
        "cache_upload",
        request_id = request_id.map(|Extension(id)| id.0).unwrap_or(0),
        route = "/api/data/cache",
        ordinary_bars = req.data.len(),
        packed = req.data.is_empty(),
    );
    let completion_span = span.clone();
    // Selection, packed decoding, and hashing are explicit CPU work over the
    // whole payload; offload them to the blocking pool. The closure owns the
    // request, so large vectors move in instead of being cloned.
    let worker = run_on_blocking_pool(move || {
        let _admission_permit = admission_permit;
        let _entered = span.enter();
        // The cache ID must distinguish assets with the same time range and
        // bar count. Asset Opportunity commonly uploads many synthetic
        // datasets that share both, so a range-only key can silently run a
        // candidate against the wrong asset.
        let data = if !req.data.is_empty() {
            req.data
        } else if let Some(packed_data) = req.packed_data {
            decode_packed_ohlcv(packed_data)
                .map_err(|message| (StatusCode::BAD_REQUEST, message))?
        } else {
            return Err((
                StatusCode::BAD_REQUEST,
                "Cache request has no data".to_string(),
            ));
        };
        let cache_id = cache_id_for_data(&data);
        let bar_count = data.len();
        Ok((data, bar_count, cache_id))
    })
    .await;
    // An inner validation error keeps its 400 status; only a failed worker
    // join becomes the outer 500.
    let worker =
        worker.and_then(|(inner, pool_wait_ms)| inner.map(|prepared| (prepared, pool_wait_ms)));
    let ((data, bar_count, cache_id), pool_wait_ms) = match worker {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(
                parent: &completion_span,
                status = error.0.as_u16(),
                error = %error.1,
                "cache upload worker failed"
            );
            return Err(error);
        }
    };
    // Store in cache only after decoding finished; no cache lock is held
    // while the payload decodes or hashes.
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
    let total_ms = elapsed_ms_since(start);
    tracing::info!(
        parent: &completion_span,
        bars = bar_count,
        cache_id = %cache_id,
        pool_wait_ms = pool_wait_ms,
        total_ms = total_ms,
        "cache upload complete"
    );
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
    Extension(admission_permit): Extension<Arc<OwnedSemaphorePermit>>,
    request_id: Option<Extension<RequestId>>,
    State(state): State<AppState>,
    Json(req): Json<CachedBatchBacktestRequest>,
) -> Result<Json<BatchBacktestResponse>, (StatusCode, String)> {
    let span = tracing::info_span!(
        "backtest_batch_cached",
        request_id = request_id.map(|Extension(id)| id.0).unwrap_or(0),
        route = "/api/backtest/batch/cached",
        items = req.items.len(),
        compact = req.compact,
        skip_drawdown = req.skip_drawdown,
        skip_sharpe_ratio = req.skip_sharpe_ratio,
    );
    // Validate before touching the cache so unsupported requests never hit
    // simulation or dispatch.
    if let Err(error) = reject_unsupported_packed_signals(&req.items) {
        tracing::warn!(
            parent: &span,
            status = error.0.as_u16(),
            error = %error.1,
            "batch rejected"
        );
        return Err(error);
    }
    // The clock starts before the cache lookup and stops at result assembly,
    // so cached-lookup and blocking-pool wait are part of the measurement.
    let start = Instant::now();
    let completion_span = span.clone();
    // Get cached data
    let data = get_cached_dataset(&state, &req.cache_id).await;
    let data = match data {
        Some(d) => d,
        None => {
            tracing::warn!(
                parent: &span,
                status = StatusCode::NOT_FOUND.as_u16(),
                cache_id = %req.cache_id,
                "cache miss"
            );
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
        parent: &span,
        bars = data.len(),
        "cache hit; dispatching batch simulation"
    );
    let bar_count = data.len();
    let worker = run_on_blocking_pool(move || {
        let _admission_permit = admission_permit;
        let _entered = span.enter();
        let prep_started = Instant::now();
        let market_series = build_market_series(data.as_slice());
        let market_prep_ms = elapsed_ms_since(prep_started);
        let simulate_started = Instant::now();
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
        let simulate_ms = elapsed_ms_since(simulate_started);
        let response = BatchBacktestResponse {
            results,
            processing_time_ms: 0,
        };
        (response, market_prep_ms, simulate_ms)
    })
    .await;
    let ((mut response, market_prep_ms, simulate_ms), pool_wait_ms) = match worker {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(
                parent: &completion_span,
                status = error.0.as_u16(),
                error = %error.1,
                "blocking worker failed"
            );
            return Err(error);
        }
    };
    // The reported batch timing includes cache lookup and pool wait, so it is
    // stamped only after the worker completes.
    response.processing_time_ms = elapsed_ms_since(start);
    let timings = WorkerStageTimings {
        pool_wait_ms,
        market_prep_ms,
        simulate_ms,
    };
    tracing::info!(
        parent: &completion_span,
        bars = bar_count,
        pool_wait_ms = timings.pool_wait_ms,
        market_prep_ms = timings.market_prep_ms,
        simulate_ms = timings.simulate_ms,
        total_ms = response.processing_time_ms,
        "cached batch backtest complete"
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

    fn admission_permit(state: &AppState) -> Arc<OwnedSemaphorePermit> {
        Arc::new(
            state
                .max_in_flight
                .clone()
                .try_acquire_owned()
                .expect("test admission permit should be available"),
        )
    }

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
        let state = AppState::default();
        let full = backtest_handler(
            Extension(admission_permit(&state)),
            None,
            Json(make_backtest_request(false, false)),
        )
        .await
        .expect("generic backtest worker should complete")
        .0
        .result;
        assert!(!full.equity_curve.is_empty());
        assert_eq!(full.trades.len(), 1);

        let compact = backtest_handler(
            Extension(admission_permit(&state)),
            None,
            Json(make_backtest_request(true, false)),
        )
        .await
        .expect("generic compact backtest worker should complete")
        .0
        .result;
        assert!(compact.equity_curve.is_empty());
        assert!(compact.trades.is_empty());
        assert_eq!(compact.total_trades, full.total_trades);

        let compact_with_trades = backtest_handler(
            Extension(admission_permit(&state)),
            None,
            Json(make_backtest_request(true, true)),
        )
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
        let state = AppState::default();
        let response = batch_backtest_handler(
            Extension(admission_permit(&state)),
            None,
            Json(BatchBacktestRequest {
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
            }),
        )
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
        let (worker_thread, pool_wait_ms) = run_on_blocking_pool(|| std::thread::current().id())
            .await
            .expect("blocking worker should complete");

        assert_ne!(executor_thread, worker_thread);
        // On this quiet runtime the worker starts immediately, but the
        // attribution must still be a sane nonnegative value.
        assert!(pool_wait_ms <= 1_000, "pool wait {pool_wait_ms}ms");
    }

    #[test]
    fn pool_wait_attribution_uses_handshakes_not_elapsed_thresholds() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .build()
            .expect("single-blocking-thread runtime should build");
        runtime.block_on(async {
            // Occupy the only blocking thread with controlled work.
            let (holder_started_tx, holder_started_rx) = std::sync::mpsc::channel::<()>();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let (holder_done_tx, holder_done_rx) = std::sync::mpsc::channel::<Instant>();
            let holder = tokio::task::spawn_blocking(move || {
                holder_started_tx
                    .send(())
                    .expect("holder started signal receiver lives");
                if release_rx
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .is_err()
                {
                    panic!("holder was never released; test cleanup failed");
                }
                // Deterministic post-release hold performed by the holder
                // itself: the queued closure cannot start before this ends,
                // regardless of scheduler speed.
                std::thread::sleep(std::time::Duration::from_millis(5));
                holder_done_tx
                    .send(Instant::now())
                    .expect("holder done signal receiver lives");
            });
            holder_started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("holder must start");

            // Dispatch the queued closure, then release the holder. Two
            // yields let the runtime register the spawn_blocking dispatch
            // before the release, so dispatch happens-before release in
            // program order rather than by elapsed time.
            let queued = tokio::spawn(run_on_blocking_pool(Instant::now));
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            let _ = release_tx.send(());

            let (queued_started, pool_wait_ms) = queued
                .await
                .expect("queued task joins")
                .expect("queued worker should complete");
            let holder_done = holder_done_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("holder done signal");
            holder.await.expect("holder task should join");

            // Ordering proves real queueing: the queued closure can only
            // start after the holder released its thread.
            assert!(
                queued_started >= holder_done,
                "queued closure must start only after the holder finished"
            );
            // The wait covers at least the holder's own post-release hold,
            // because dispatch happened before the release.
            assert!(
                pool_wait_ms >= 3,
                "queued work must attribute its blocking-pool wait, got {pool_wait_ms}ms"
            );
        });
    }

    #[tokio::test]
    async fn processing_time_fields_use_camel_case_nonnegative_integers() {
        let request = make_backtest_request(false, false);
        let state = AppState::default();
        let single = backtest_handler(
            Extension(admission_permit(&state)),
            None,
            Json(request.clone()),
        )
        .await
        .expect("single handler should complete")
        .0;
        let single_json = serde_json::to_value(BacktestResponse {
            result: single.result,
            processing_time_ms: single.processing_time_ms,
        })
        .unwrap();
        assert!(single_json["processingTimeMs"].is_u64());

        let batch = batch_backtest_handler(
            Extension(admission_permit(&state)),
            None,
            Json(BatchBacktestRequest {
                data: request.data.clone(),
                items: vec![crate::types::BatchBacktestItem {
                    id: "candidate-1".to_string(),
                    signals: request.signals.clone(),
                    packed_signals: None,
                    settings: None,
                }],
                initial_capital: request.initial_capital,
                position_size_percent: request.position_size_percent,
                commission_percent: request.commission_percent,
                base_settings: request.settings.clone(),
                sizing: request.sizing,
                compact: request.compact,
                skip_drawdown: false,
                skip_sharpe_ratio: false,
            }),
        )
        .await
        .expect("batch handler should complete")
        .0;
        let batch_json = serde_json::to_value(&batch).unwrap();
        assert!(batch_json["processingTimeMs"].is_u64());
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

    fn sample_upload_data() -> Vec<OHLCV> {
        vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(60000, 105.0, 106.0, 104.0, 105.0, 1000.0),
            OHLCV::new(120000, 105.0, 106.0, 104.0, 105.0, 1000.0),
        ]
    }

    fn packed_from_data(data: &[OHLCV]) -> Vec<f64> {
        data.iter()
            .flat_map(|bar| {
                [
                    bar.time as f64,
                    bar.open,
                    bar.high,
                    bar.low,
                    bar.close,
                    bar.volume,
                ]
            })
            .collect()
    }

    async fn upload(State(state): State<AppState>, request: CacheDataRequest) -> CacheDataResponse {
        cache_data_handler(
            Extension(admission_permit(&state)),
            None,
            State(state),
            Json(request),
        )
        .await
        .expect("upload should succeed")
        .0
    }

    #[tokio::test]
    async fn cache_upload_assigns_equivalent_ids_to_ordinary_and_packed_data() {
        let state = AppState::default();
        let ordinary = upload(
            State(state.clone()),
            CacheDataRequest {
                data: sample_upload_data(),
                packed_data: None,
            },
        )
        .await;
        let packed = upload(
            State(state.clone()),
            CacheDataRequest {
                data: Vec::new(),
                packed_data: Some(packed_from_data(&sample_upload_data())),
            },
        )
        .await;
        assert_eq!(ordinary.cache_id, packed.cache_id);
        assert_eq!(ordinary.bar_count, packed.bar_count);
        // Re-uploading identical data converges on the same cache entry.
        let repeat = upload(
            State(state),
            CacheDataRequest {
                data: sample_upload_data(),
                packed_data: None,
            },
        )
        .await;
        assert_eq!(ordinary.cache_id, repeat.cache_id);
    }

    #[tokio::test]
    async fn cache_upload_distinguishes_interior_price_changes() {
        let state = AppState::default();
        let mut changed = sample_upload_data();
        changed[1].close += 0.5;
        let baseline = upload(
            State(state.clone()),
            CacheDataRequest {
                data: sample_upload_data(),
                packed_data: None,
            },
        )
        .await;
        let changed = upload(
            State(state),
            CacheDataRequest {
                data: changed,
                packed_data: None,
            },
        )
        .await;
        assert_ne!(baseline.cache_id, changed.cache_id);
    }

    #[tokio::test]
    async fn cache_upload_rejects_malformed_and_empty_packed_data() {
        let state = AppState::default();
        let malformed = cache_data_handler(
            Extension(admission_permit(&state)),
            None,
            State(state.clone()),
            Json(CacheDataRequest {
                data: Vec::new(),
                packed_data: Some(vec![1.0, 2.0, 3.0]),
            }),
        )
        .await
        .expect_err("malformed packed length must fail");
        assert_eq!(malformed.0, StatusCode::BAD_REQUEST);

        let non_finite = cache_data_handler(
            Extension(admission_permit(&state)),
            None,
            State(state.clone()),
            Json(CacheDataRequest {
                data: Vec::new(),
                packed_data: Some(vec![0.0, 100.0, 101.0, 99.0, 100.0, f64::NAN]),
            }),
        )
        .await
        .expect_err("non-finite packed values must fail");
        assert_eq!(non_finite.0, StatusCode::BAD_REQUEST);

        let empty = cache_data_handler(
            Extension(admission_permit(&state)),
            None,
            State(state.clone()),
            Json(CacheDataRequest {
                data: Vec::new(),
                packed_data: Some(Vec::new()),
            }),
        )
        .await
        .expect_err("empty packed payload must fail");
        assert_eq!(empty.0, StatusCode::BAD_REQUEST);

        let no_data = cache_data_handler(
            Extension(admission_permit(&state)),
            None,
            State(state),
            Json(CacheDataRequest {
                data: Vec::new(),
                packed_data: None,
            }),
        )
        .await
        .expect_err("request without data must fail");
        assert_eq!(no_data.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cache_upload_decode_and_hash_run_off_the_async_executor() {
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        let state = AppState::default();
        // Roughly 100k bars of packed rows: decoding and hashing take far
        // longer than the executor-progress probe below needs, so the
        // ordering assertion is robust without any timing thresholds.
        let packed: Vec<f64> = (0..600_000).map(|index| (index % 997) as f64).collect();
        let request = CacheDataRequest {
            data: Vec::new(),
            packed_data: Some(packed),
        };
        let done = Arc::new(AtomicBool::new(false));

        let upload_state = state.clone();
        let done_for_upload = Arc::clone(&done);
        let upload_task = tokio::spawn(async move {
            let result = cache_data_handler(
                Extension(admission_permit(&upload_state)),
                None,
                State(upload_state),
                Json(request),
            )
            .await;
            done_for_upload.store(true, AtomicOrdering::SeqCst);
            result
        });

        // Executor-progress probe: while the upload's decode/hash occupies a
        // blocking worker, this single-threaded executor must still run other
        // tasks. If decode ran inline, the upload would complete before the
        // probe ever reached its checkpoint.
        let done_for_probe = Arc::clone(&done);
        let probe = async move {
            let mut checkpoint = 0_u32;
            while checkpoint < 100 {
                assert!(
                    !done_for_probe.load(AtomicOrdering::SeqCst),
                    "upload completed before the executor-progress checkpoint;                      decode is not offloaded"
                );
                tokio::task::yield_now().await;
                checkpoint += 1;
            }
        };

        let (upload_result, ()) = tokio::join!(upload_task, probe);
        let response = upload_result
            .expect("upload task should join")
            .expect("upload should succeed")
            .0;
        assert_eq!(response.bar_count, 100_000);
        assert!(done.load(AtomicOrdering::SeqCst));
    }

    // ======================================================================
    // Structured log capture. The global subscriber is installed once per
    // process and every event lands in one shared buffer; capture tests
    // serialize on a mutex and filter by unique markers.
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

    /// Install the capturing subscriber once per process. Tests that assert
    /// on log records must hold [`log_capture_lock`] while they act.
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

    #[tokio::test]
    async fn structured_logs_cover_success_cache_miss_and_worker_failure() {
        init_log_capture();
        let _guard = log_capture_lock().await;

        // Success: a unique bar count marks this request's completion record.
        let state = AppState::default();
        let mut request = make_backtest_request(false, false);
        request.data = (0..31_337)
            .map(|index| {
                let base = 100.0 + (index as f64) * 0.01;
                OHLCV::new(
                    index as i64 * 60_000,
                    base,
                    base + 0.5,
                    base - 0.5,
                    base,
                    1000.0,
                )
            })
            .collect();
        let response = backtest_handler(
            Extension(admission_permit(&state)),
            Some(Extension(RequestId(424_242))),
            Json(request),
        )
        .await
        .expect("capture success handler should complete");
        assert_eq!(response.0.result.total_trades, 1);
        let success_records = records_containing("bars=31337");
        assert!(
            success_records
                .iter()
                .any(|record| record.contains("backtest complete")
                    && record.contains("request_id=424242")
                    && record.contains("pool_wait_ms=")
                    && record.contains("simulate_ms=")),
            "success completion record missing stage fields: {success_records:?}"
        );

        // Cache miss: a warn event carrying the unknown cache id.
        let payload = serde_json::json!({
            "cacheId": "log-capture-missing-cache-id",
            "items": [{"id": "capture-1", "signals": []}],
            "initialCapital": 10000.0,
            "positionSizePercent": 100.0,
            "commissionPercent": 0.0
        });
        let request: CachedBatchBacktestRequest = serde_json::from_value(payload).unwrap();
        let error = cached_batch_backtest_handler(
            Extension(admission_permit(&state)),
            Some(Extension(RequestId(424_243))),
            State(state.clone()),
            Json(request),
        )
        .await
        .expect_err("missing cache id must fail");
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        let miss_records = records_containing("log-capture-missing-cache-id");
        assert!(
            miss_records
                .iter()
                .any(|record| record.contains("cache miss")),
            "cache-miss warn event missing: {miss_records:?}"
        );

        // Worker join failure: the pool runner logs the failed task.
        let result = run_on_blocking_pool(|| -> BacktestResult {
            panic!("injected worker failure for log capture")
        })
        .await;
        assert!(result.is_err(), "panicking worker must surface an error");
        let failure_records = records_containing("CPU-bound task failed");
        assert!(
            failure_records
                .iter()
                .any(|record| record.contains("injected worker failure")),
            "worker failure log missing: {failure_records:?}"
        );
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
        let state = AppState::default();
        for packed in [
            serde_json::json!([0.0, 0.0, 100.0, 0.0]),
            serde_json::json!([]),
        ] {
            let mut payload = batch_request_payload(None);
            payload["items"][0]["packedSignals"] = packed;
            let request: BatchBacktestRequest =
                serde_json::from_value(payload).expect("camelCase batch payload must deserialize");
            let error =
                batch_backtest_handler(Extension(admission_permit(&state)), None, Json(request))
                    .await
                    .expect_err("packed items must be rejected");
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
            assert!(error.1.contains(packed_rejection_message()));
        }

        // Without the field, the ordinary signals keep their results.
        let request: BatchBacktestRequest =
            serde_json::from_value(batch_request_payload(None)).unwrap();
        let response =
            batch_backtest_handler(Extension(admission_permit(&state)), None, Json(request))
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
        let error = cached_batch_backtest_handler(
            Extension(admission_permit(&state)),
            None,
            State(state.clone()),
            Json(request),
        )
        .await
        .expect_err("packed items must be rejected before cache lookup");
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(error.1.contains(packed_rejection_message()));

        // Invalid cached IDs still report NOT_FOUND for ordinary requests.
        let mut payload = batch_request_payload(None);
        payload["cacheId"] = serde_json::json!("never-uploaded");
        let request: CachedBatchBacktestRequest = serde_json::from_value(payload).unwrap();
        let error = cached_batch_backtest_handler(
            Extension(admission_permit(&state)),
            None,
            State(state),
            Json(request),
        )
        .await
        .expect_err("unknown cache id must 404");
        assert_eq!(error.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cached_batch_route_runs_ordinary_items_after_upload() {
        let state = AppState::default();
        let upload = cache_data_handler(
            Extension(admission_permit(&state)),
            None,
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
        let response = cached_batch_backtest_handler(
            Extension(admission_permit(&state)),
            None,
            State(state),
            Json(request),
        )
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
        // Production requests get their admission permit from the middleware;
        // this minimal router inserts the same extension directly.
        axum::Router::new()
            .route(
                "/api/backtest/batch",
                axum::routing::post(batch_backtest_handler),
            )
            .route(
                "/api/backtest/batch/cached",
                axum::routing::post(cached_batch_backtest_handler),
            )
            .layer(Extension(admission_permit(&state)))
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
