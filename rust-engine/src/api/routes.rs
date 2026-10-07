//! API Routes and Handlers
use crate::backtest::{build_market_series, run_backtest_with_market_series_options, MarketSeries};
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
/// Admission is opt-in: when `RUST_ENGINE_MAX_IN_FLIGHT` is absent the
/// engine keeps its pre-admission, unbounded behavior, and a configured
/// positive integer bounds in-flight CPU-heavy work to that count. There is
/// deliberately no built-in default: a bounded default shipped without real
/// Finder validation produced heavy fallback churn in measurement, and no
/// universal "safe" limit exists across machines and workloads. Run
/// `scripts/validate-finder-admission.ts` against real workloads and set the
/// variable explicitly from those results.
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
    /// Admission bound shared by every CPU-heavy route. Unbounded admission
    /// carries a max-capacity semaphore so the permit lifecycle is identical
    /// in both modes.
    pub max_in_flight: Arc<Semaphore>,
    /// The configured admission limit, kept for structured diagnostics.
    max_in_flight_limit: Option<usize>,
    request_counter: Arc<AtomicU64>,
}
impl AppState {
    /// `Some(limit)` bounds in-flight CPU-heavy work; `None` keeps the
    /// pre-admission unbounded behavior. Unbounded state carries a
    /// max-capacity semaphore so the middleware and permit-lifetime paths are
    /// identical in both modes and can never reject.
    pub fn new(max_in_flight: Option<usize>) -> Self {
        Self {
            data_cache: Arc::new(RwLock::new(HashMap::new())),
            cache_access_counter: Arc::new(AtomicU64::new(0)),
            max_in_flight: Arc::new(Semaphore::new(
                max_in_flight.unwrap_or(Semaphore::MAX_PERMITS),
            )),
            max_in_flight_limit: max_in_flight,
            request_counter: Arc::new(AtomicU64::new(0)),
        }
    }
    /// The configured admission limit, for diagnostic events. `None` means
    /// admission is disabled (pre-admission behavior).
    pub fn max_in_flight_limit(&self) -> Option<usize> {
        self.max_in_flight_limit
    }
    /// Monotonic per-process request identifier for log correlation.
    pub fn next_request_id(&self) -> u64 {
        self.request_counter.fetch_add(1, Ordering::Relaxed) + 1
    }
}
impl Default for AppState {
    fn default() -> Self {
        Self::new(None)
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
/// Map a blocking-worker outcome for a handler, logging request-associated
/// failures under the request span. Every CPU-heavy handler routes its worker
/// result through this function, so a worker join failure always produces one
/// `blocking worker failed` event carrying the request's identity.
fn map_worker_result<T>(
    completion_span: &tracing::Span,
    worker: Result<(T, u64), (StatusCode, String)>,
) -> Result<(T, u64), (StatusCode, String)> {
    match worker {
        Ok(value) => Ok(value),
        Err(error) => {
            tracing::error!(
                parent: completion_span,
                status = error.0.as_u16(),
                error = %error.1,
                "blocking worker failed"
            );
            Err(error)
        }
    }
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
/// Simulate every batch item against one prepared market view. Both batch
/// routes share this synchronous item loop; each handler keeps market
/// preparation, stage clocks, validation, dispatch, and response assembly.
/// An item's settings replace the base object wholesale; fields are never
/// merged.
#[allow(clippy::too_many_arguments)]
fn run_batch_items(
    data: &[OHLCV],
    items: &[crate::types::BatchBacktestItem],
    base_settings: &crate::types::BacktestSettings,
    sizing: &crate::types::TradeSizingConfig,
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
    compact: bool,
    skip_drawdown: bool,
    skip_sharpe_ratio: bool,
    market_series: &MarketSeries<'_>,
) -> Vec<BatchBacktestResultItem> {
    items
        .par_iter()
        .map(|item| {
            let settings = item.settings.as_ref().unwrap_or(base_settings);
            let result = run_backtest_with_market_series_options(
                data,
                &item.signals,
                initial_capital,
                position_size_percent,
                commission_percent,
                settings,
                Some(sizing),
                compact,
                // Batch results never retain trades unless a later stage
                // needs them; the kernel default for batches stays false.
                false,
                skip_drawdown,
                skip_sharpe_ratio,
                market_series,
            );
            BatchBacktestResultItem {
                id: item.id.clone(),
                result,
            }
        })
        .collect()
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
    let ((result, market_prep_ms, simulate_ms), pool_wait_ms) =
        map_worker_result(&completion_span, worker)?;
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
        let results = run_batch_items(
            &req.data,
            &req.items,
            &req.base_settings,
            &req.sizing,
            req.initial_capital,
            req.position_size_percent,
            req.commission_percent,
            req.compact,
            req.skip_drawdown,
            req.skip_sharpe_ratio,
            &market_series,
        );
        let simulate_ms = elapsed_ms_since(simulate_started);
        let response = BatchBacktestResponse {
            results,
            processing_time_ms: 0,
        };
        (response, market_prep_ms, simulate_ms)
    })
    .await;
    let ((mut response, market_prep_ms, simulate_ms), pool_wait_ms) =
        map_worker_result(&completion_span, worker)?;
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
    let ((data, bar_count, cache_id), pool_wait_ms) = map_worker_result(&completion_span, worker)?;
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
        let results = run_batch_items(
            data.as_slice(),
            &req.items,
            &req.base_settings,
            &req.sizing,
            req.initial_capital,
            req.position_size_percent,
            req.commission_percent,
            req.compact,
            req.skip_drawdown,
            req.skip_sharpe_ratio,
            &market_series,
        );
        let simulate_ms = elapsed_ms_since(simulate_started);
        let response = BatchBacktestResponse {
            results,
            processing_time_ms: 0,
        };
        (response, market_prep_ms, simulate_ms)
    })
    .await;
    let ((mut response, market_prep_ms, simulate_ms), pool_wait_ms) =
        map_worker_result(&completion_span, worker)?;
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
    use std::future::Future as _;

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

            // Dispatch the queued closure deterministically: one manual poll
            // runs run_on_blocking_pool up to its spawn_blocking await, which
            // submits the blocking task and stamps the dispatch time before
            // the holder is released. Dispatch happens-before release by
            // construction, with no scheduler guarantee involved.
            let queued = run_on_blocking_pool(Instant::now);
            tokio::pin!(queued);
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            let _ = queued.as_mut().poll(&mut cx);
            let _ = release_tx.send(());

            let (queued_started, pool_wait_ms) =
                queued.await.expect("queued worker should complete");
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

    #[test]
    fn cache_upload_decode_stays_offloaded_while_a_worker_is_deliberately_held() {
        // Single-threaded executor with a single blocking-worker slot: the
        // held worker below occupies that slot, so an offloaded decode cannot
        // even start, while an inline decode would run synchronously on this
        // executor during the first poll. The discriminator is structural,
        // not a relative-speed measurement.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .build()
            .expect("single-blocking-thread runtime should build");
        runtime.block_on(async {
            let state = AppState::default();
            // Deliberately hold the only blocking worker behind a release
            // gate with worker-start synchronization.
            let (holder_started_tx, holder_started_rx) = std::sync::mpsc::channel::<()>();
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let holder = tokio::task::spawn_blocking(move || {
                holder_started_tx
                    .send(())
                    .expect("held worker signal receiver lives");
                if release_rx
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .is_err()
                {
                    panic!("held worker was never released; test cleanup failed");
                }
            });
            holder_started_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("held worker must start");

            // Roughly 100k bars of packed rows.
            let packed: Vec<f64> = (0..600_000).map(|index| (index % 997) as f64).collect();
            let request = CacheDataRequest {
                data: Vec::new(),
                packed_data: Some(packed),
            };
            let upload = cache_data_handler(
                Extension(admission_permit(&state)),
                None,
                State(state.clone()),
                Json(request),
            );
            tokio::pin!(upload);
            // One manual poll: with correct offloading this dispatches the
            // decode behind the held worker and returns Pending; with inline
            // decoding it would run the whole decode and hash to completion
            // right here on the executor.
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            let _ = upload.as_mut().poll(&mut cx);
            assert!(
                state.data_cache.read().await.is_empty(),
                "decode ran on the async executor instead of the blocking pool"
            );
            // The executor must still make progress while the worker is held.
            tokio::task::yield_now().await;
            assert!(
                state.data_cache.read().await.is_empty(),
                "decode started despite the blocking worker still being held"
            );

            // Release the held worker and let the upload finish.
            let _ = release_tx.send(());
            let response = upload.await.expect("upload should succeed after release").0;
            assert_eq!(response.bar_count, 100_000);
            holder.await.expect("held worker joins");
        });
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
            miss_records.iter().any(|record| {
                record.contains("cache miss")
                    && record.contains("request_id=424243")
                    && record.contains("route=")
            }),
            "cache-miss warn event missing or missing request identity: {miss_records:?}"
        );

        // Worker join failure through the shared handler path: a real pool
        // failure flows through map_worker_result — the exact function every
        // CPU-heavy handler uses — under a span carrying the request
        // identity, and must emit the request-associated event.
        let failure_span = tracing::info_span!(
            "backtest_single",
            request_id = 424_244,
            route = "/api/backtest",
        );
        let worker = run_on_blocking_pool(|| -> BacktestResult {
            panic!("injected worker failure for log capture")
        })
        .await;
        let error = map_worker_result(&failure_span, worker)
            .expect_err("panicking worker must surface an error");
        assert_eq!(error.0, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.1.contains("injected worker failure"));
        let failure_records = records_containing("blocking worker failed");
        assert!(
            failure_records.iter().any(|record| {
                record.contains("injected worker failure")
                    && record.contains("request_id=424244")
                    && record.contains("route=")
                    && record.contains("status=500")
            }),
            "handler worker-failure event missing or missing request fields: {failure_records:?}"
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

    // ======================================================================
    // Direct and cached routes must agree on one heterogeneous batch, and
    // the batch must satisfy independently derived contracts: exact trade
    // fills per item, base-versus-item settings replacement, nonzero
    // drawdown and Sharpe while enabled, and exact zeros for skipped
    // metrics in every skip combination across both output modes. Route
    // equality is an additional check, not the contract itself — both
    // routes share one item loop, so a shared mistake would pass equality.
    // ======================================================================

    fn strengthened_batch_data() -> Vec<OHLCV> {
        vec![
            OHLCV::new(0, 100.0, 101.0, 99.0, 100.0, 1000.0),
            OHLCV::new(60000, 90.0, 91.0, 89.0, 90.0, 1000.0),
            OHLCV::new(120000, 105.0, 106.0, 104.0, 105.0, 1000.0),
            OHLCV::new(180000, 95.0, 96.0, 94.0, 95.0, 1000.0),
            OHLCV::new(240000, 110.0, 111.0, 109.0, 110.0, 1000.0),
        ]
    }

    /// The base settings carry a nondefault active risk setting, so an item
    /// that explicitly disables it proves settings replacement instead of
    /// inheritance or field merging.
    fn strengthened_base_settings() -> crate::types::BacktestSettings {
        crate::types::BacktestSettings {
            risk_max_hold_enabled: true,
            risk_max_hold_bars: 1,
            ..crate::types::BacktestSettings::default()
        }
    }

    fn strengthened_items() -> Vec<crate::types::BatchBacktestItem> {
        let no_max_hold = crate::types::BacktestSettings {
            risk_max_hold_enabled: false,
            risk_max_hold_bars: 0,
            ..crate::types::BacktestSettings::default()
        };
        let short_next_open = crate::types::BacktestSettings {
            trade_direction: crate::types::TradeDirection::Short,
            execution_model: crate::types::ExecutionModel::NextOpen,
            risk_max_hold_enabled: false,
            risk_max_hold_bars: 0,
            ..crate::types::BacktestSettings::default()
        };
        let signals = vec![
            Signal::buy(0, 100.0),
            Signal::sell(120000, 105.0),
            Signal::buy(180000, 95.0),
            Signal::sell(240000, 110.0),
        ];
        vec![
            // No item settings: the base settings (including the one-bar max
            // hold) apply.
            crate::types::BatchBacktestItem {
                id: "base-max-hold".to_string(),
                signals: signals.clone(),
                packed_signals: None,
                settings: None,
            },
            // Item settings replace the base object wholesale: the explicit
            // max-hold disable must survive even though the base enables it.
            crate::types::BatchBacktestItem {
                id: "override-no-max-hold".to_string(),
                signals: signals.clone(),
                packed_signals: None,
                settings: Some(no_max_hold),
            },
            // Direction and execution-model replacement: next-open fills
            // shift one bar and a short entry sells first.
            crate::types::BatchBacktestItem {
                id: "short-next-open".to_string(),
                signals: vec![Signal::sell(0, 100.0), Signal::buy(120000, 105.0)],
                packed_signals: None,
                settings: Some(short_next_open),
            },
            // Ordinary empty signals stay a valid no-trade candidate.
            crate::types::BatchBacktestItem {
                id: "empty-signals".to_string(),
                signals: Vec::new(),
                packed_signals: None,
                settings: None,
            },
        ]
    }

    async fn run_strengthened_batch_through_both_routes(
        state: &AppState,
        items: Vec<crate::types::BatchBacktestItem>,
        compact: bool,
        skip_drawdown: bool,
        skip_sharpe_ratio: bool,
    ) -> (serde_json::Value, serde_json::Value) {
        let data = strengthened_batch_data();
        let direct = batch_backtest_handler(
            Extension(admission_permit(state)),
            None,
            Json(BatchBacktestRequest {
                data: data.clone(),
                items: items.clone(),
                initial_capital: 10_000.0,
                position_size_percent: 100.0,
                commission_percent: 0.0,
                base_settings: strengthened_base_settings(),
                sizing: crate::types::TradeSizingConfig::default(),
                compact,
                skip_drawdown,
                skip_sharpe_ratio,
            }),
        )
        .await
        .expect("direct batch worker should complete")
        .0;
        let upload = cache_data_handler(
            Extension(admission_permit(state)),
            None,
            State(state.clone()),
            Json(CacheDataRequest {
                data,
                packed_data: None,
            }),
        )
        .await
        .expect("upload should succeed")
        .0;
        let cached = cached_batch_backtest_handler(
            Extension(admission_permit(state)),
            None,
            State(state.clone()),
            Json(CachedBatchBacktestRequest {
                cache_id: upload.cache_id,
                items,
                initial_capital: 10_000.0,
                position_size_percent: 100.0,
                commission_percent: 0.0,
                base_settings: strengthened_base_settings(),
                sizing: crate::types::TradeSizingConfig::default(),
                compact,
                skip_drawdown,
                skip_sharpe_ratio,
            }),
        )
        .await
        .expect("cached batch worker should complete")
        .0;
        (
            serde_json::to_value(direct.results).unwrap(),
            serde_json::to_value(cached.results).unwrap(),
        )
    }

    /// The kernel's documented Sharpe over two trades: mean pnl percent over
    /// n, sample deviation over n - 1, zero when the deviation vanishes.
    fn sharpe_of_two_trades(pnl_percents: [f64; 2]) -> f64 {
        let mean = (pnl_percents[0] + pnl_percents[1]) / 2.0;
        let deviation = pnl_percents[0] - mean;
        let std_dev = (2.0 * deviation * deviation).sqrt();
        if std_dev == 0.0 {
            0.0
        } else {
            mean / std_dev
        }
    }

    fn assert_value_close(actual: &serde_json::Value, expected: f64, label: &str) {
        let value = actual
            .as_f64()
            .unwrap_or_else(|| panic!("{label}: not a number: {actual}"));
        assert!(
            (value - expected).abs() <= 1e-9 * expected.abs().max(1.0),
            "{label}: actual {value} expected {expected}"
        );
    }

    /// Exact fills for the strengthened items in full-output runs. The two
    /// long candidates share entries but must differ in exit fills because
    /// the base's one-bar max hold replaces the signal exits with time
    /// stops; the short next-open candidate shifts both fills one bar.
    fn assert_exact_trades(results: &serde_json::Value, label: &str) {
        let base_trades = results[0]["result"]["trades"].as_array().unwrap();
        assert_eq!(base_trades.len(), 2, "{label}: base-max-hold trades");
        assert_eq!(base_trades[0]["type"], "long");
        assert_eq!(base_trades[0]["entryTime"], 0);
        assert_value_close(
            &base_trades[0]["entryPrice"],
            100.0,
            "{label} base t0 entry",
        );
        assert_eq!(base_trades[0]["exitTime"], 60000);
        assert_value_close(&base_trades[0]["exitPrice"], 90.0, "{label} base t0 exit");
        assert_eq!(base_trades[0]["exitReason"], "time_stop");
        assert_eq!(base_trades[1]["entryTime"], 180000);
        assert_value_close(&base_trades[1]["entryPrice"], 95.0, "{label} base t1 entry");
        assert_eq!(base_trades[1]["exitTime"], 240000);
        assert_value_close(&base_trades[1]["exitPrice"], 110.0, "{label} base t1 exit");
        assert_eq!(base_trades[1]["exitReason"], "time_stop");

        let override_trades = results[1]["result"]["trades"].as_array().unwrap();
        assert_eq!(override_trades.len(), 2, "{label}: override trades");
        assert_eq!(override_trades[0]["entryTime"], 0);
        assert_value_close(
            &override_trades[0]["entryPrice"],
            100.0,
            "{label} override t0 entry",
        );
        assert_eq!(override_trades[0]["exitTime"], 120000);
        assert_value_close(
            &override_trades[0]["exitPrice"],
            105.0,
            "{label} override t0 exit",
        );
        assert_eq!(override_trades[0]["exitReason"], "signal");
        assert_eq!(override_trades[1]["entryTime"], 180000);
        assert_value_close(
            &override_trades[1]["entryPrice"],
            95.0,
            "{label} override t1 entry",
        );
        assert_eq!(override_trades[1]["exitTime"], 240000);
        assert_value_close(
            &override_trades[1]["exitPrice"],
            110.0,
            "{label} override t1 exit",
        );
        assert_eq!(override_trades[1]["exitReason"], "signal");

        let short_trades = results[2]["result"]["trades"].as_array().unwrap();
        assert_eq!(short_trades.len(), 1, "{label}: short next-open trades");
        assert_eq!(short_trades[0]["type"], "short");
        assert_eq!(short_trades[0]["entryTime"], 60000);
        assert_value_close(&short_trades[0]["entryPrice"], 90.0, "{label} short entry");
        assert_eq!(short_trades[0]["exitTime"], 180000);
        assert_value_close(&short_trades[0]["exitPrice"], 95.0, "{label} short exit");
        assert_eq!(short_trades[0]["exitReason"], "signal");
    }

    #[tokio::test]
    async fn batch_routes_cover_heterogeneous_items_and_metric_skip_combinations() {
        let state = AppState::default();
        let items = strengthened_items();

        // Independently derived expectations for 100% sizing and no fees:
        // the mark at the second bar dips to 9000 (1000 dollars, 10%) for
        // both long candidates, and the Sharpe inputs are the trade pnl
        // percents -10/+15.789 (base) and +5/+15.789 (override).
        let second_pnl_percent = (110.0 / 95.0 - 1.0) * 100.0;
        let base_sharpe = sharpe_of_two_trades([-10.0, second_pnl_percent]);
        let override_sharpe = sharpe_of_two_trades([5.0, second_pnl_percent]);
        assert!(base_sharpe != 0.0 && override_sharpe != 0.0);

        for compact in [false, true] {
            for (skip_drawdown, skip_sharpe) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                let label = format!(
                    "compact={compact} skip_drawdown={skip_drawdown} skip_sharpe={skip_sharpe}"
                );
                let (direct, cached) = run_strengthened_batch_through_both_routes(
                    &state,
                    items.clone(),
                    compact,
                    skip_drawdown,
                    skip_sharpe,
                )
                .await;
                assert_eq!(direct, cached, "{label}: routes must match");

                let ids: Vec<&str> = direct
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item["id"].as_str().unwrap())
                    .collect();
                assert_eq!(
                    ids,
                    vec![
                        "base-max-hold",
                        "override-no-max-hold",
                        "short-next-open",
                        "empty-signals"
                    ]
                );

                if compact {
                    for item in direct.as_array().unwrap() {
                        assert!(
                            item["result"]["trades"].as_array().unwrap().is_empty(),
                            "{label}: compact output drops trades"
                        );
                        assert!(
                            item["result"]["equityCurve"].as_array().unwrap().is_empty(),
                            "{label}: compact output clears the equity curve"
                        );
                    }
                } else {
                    assert_exact_trades(&direct, &label);
                    assert!(
                        !direct[0]["result"]["equityCurve"]
                            .as_array()
                            .unwrap()
                            .is_empty(),
                        "{label}: full output retains the equity curve"
                    );
                }

                for (name, result, expected_sharpe) in [
                    ("base-max-hold", &direct[0]["result"], base_sharpe),
                    (
                        "override-no-max-hold",
                        &direct[1]["result"],
                        override_sharpe,
                    ),
                ] {
                    assert_eq!(result["totalTrades"], 2, "{label}/{name}: trade count");
                    if skip_drawdown {
                        assert_eq!(result["maxDrawdown"], 0.0, "{label}/{name} drawdown");
                        assert_eq!(
                            result["maxDrawdownPercent"], 0.0,
                            "{label}/{name} drawdown percent"
                        );
                    } else {
                        assert_value_close(
                            &result["maxDrawdown"],
                            1000.0,
                            &format!("{label}/{name} drawdown"),
                        );
                        assert_value_close(
                            &result["maxDrawdownPercent"],
                            10.0,
                            &format!("{label}/{name} drawdown percent"),
                        );
                    }
                    if skip_sharpe {
                        assert_eq!(result["sharpeRatio"], 0.0, "{label}/{name} sharpe");
                    } else {
                        assert_value_close(
                            &result["sharpeRatio"],
                            expected_sharpe,
                            &format!("{label}/{name} sharpe"),
                        );
                    }
                }
                assert_eq!(
                    direct[3]["result"]["totalTrades"], 0,
                    "{label}: empty-signals candidate"
                );
            }
        }
    }

    #[tokio::test]
    async fn empty_batch_items_yield_empty_results_on_both_routes() {
        let state = AppState::default();
        let (direct, cached) =
            run_strengthened_batch_through_both_routes(&state, Vec::new(), true, false, false)
                .await;
        assert!(direct.as_array().unwrap().is_empty());
        assert!(cached.as_array().unwrap().is_empty());
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
