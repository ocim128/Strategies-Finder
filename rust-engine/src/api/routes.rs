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
    for row in values.chunks_exact(6) {
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
}
