//! API Routes and Handlers
use crate::backtest::{
    build_market_series, run_backtest_with_market_series, run_backtest_with_market_series_options,
};
use crate::types::{
    BacktestRequest, BacktestResult, BatchBacktestRequest, BatchBacktestResponse,
    BatchBacktestResultItem, FinderRequest, FinderResult, MultiAssetBatchBacktestRequest,
    MultiAssetCacheRequest, MultiAssetCacheResponse, MultiAssetCacheResult, ProgressUpdate, Signal,
    SignalType, Time, Trade, TradeType, WalkForwardRequest, WalkForwardResult, OHLCV,
};
use axum::{
    extract::ws::{WebSocket, WebSocketUpgrade},
    extract::State,
    http::StatusCode,
    response::Response,
    Json,
};
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
    /// When true, omit heavy payloads (trades, equity curve) from results
    #[serde(default)]
    pub compact: bool,
    /// Optional last candle time used by the Asset Opportunity summary route.
    #[serde(default)]
    pub last_data_time: Option<crate::types::Time>,
}
/// Minimal result needed by Asset Opportunity fresh-entry detection.
/// Keeping this separate from `BacktestResult` avoids returning every trade
/// and equity point for every candidate over HTTP.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshEntryTradeSummary {
    #[serde(rename = "type")]
    pub trade_type: TradeType,
    pub entry_time: crate::types::Time,
    pub entry_price: f64,
    pub exit_reason: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshEntrySummary {
    pub total_trades: u32,
    pub latest_trade: Option<FreshEntryTradeSummary>,
    pub is_open: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshEntryBatchResultItem {
    pub id: String,
    pub result: FreshEntrySummary,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshEntryBatchResponse {
    pub results: Vec<FreshEntryBatchResultItem>,
    pub processing_time_ms: u64,
}
/// Scalar backtest metrics used by Finder Asset Opportunity ranking.
///
/// `profit_factor: None` represents positive infinity because JSON cannot
/// encode an IEEE infinity. The TypeScript adapter reconstructs it from the
/// win/loss counts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOpportunityMetricSummary {
    pub net_profit: f64,
    pub net_profit_percent: f64,
    pub win_rate: f64,
    pub expectancy: f64,
    pub avg_trade: f64,
    pub profit_factor: Option<f64>,
    pub max_drawdown: f64,
    pub max_drawdown_percent: f64,
    pub total_trades: u32,
    pub winning_trades: u32,
    pub losing_trades: u32,
    pub avg_win: f64,
    pub avg_loss: f64,
    pub sharpe_ratio: f64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOpportunityBatchResultItem {
    pub id: String,
    pub result: AssetOpportunityMetricSummary,
    pub selection_result: AssetOpportunityMetricSummary,
    pub endpoint_adjusted: bool,
    pub endpoint_removed_trades: usize,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetOpportunityBatchResponse {
    pub results: Vec<AssetOpportunityBatchResultItem>,
    pub processing_time_ms: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cache_ids: Vec<MultiAssetCacheResult>,
}
/// Proxy request structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyRequest {
    pub url: String,
}
// ============================================================================
// Handlers
// ============================================================================
/// Handle backtest request
pub async fn backtest_handler(Json(req): Json<BacktestRequest>) -> Json<BacktestResult> {
    let market_series = build_market_series(&req.data);
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
        &market_series,
    );
    Json(result)
}
/// Handle batch backtest request - runs multiple backtests in parallel
pub async fn batch_backtest_handler(
    Json(req): Json<BatchBacktestRequest>,
) -> Json<BatchBacktestResponse> {
    let start = Instant::now();
    let market_series = build_market_series(&req.data);
    // Run all backtests in parallel using rayon
    let results: Vec<BatchBacktestResultItem> = req
        .items
        .par_iter()
        .map(|item| {
            // Use item-specific settings if provided, otherwise use base settings
            let settings = item
                .settings
                .clone()
                .unwrap_or_else(|| req.base_settings.clone());
            let result = run_backtest_with_market_series(
                &req.data,
                &item.signals,
                req.initial_capital,
                req.position_size_percent,
                req.commission_percent,
                &settings,
                Some(&req.sizing),
                req.compact,
                &market_series,
            );
            BatchBacktestResultItem {
                id: item.id.clone(),
                result,
            }
        })
        .collect();
    let processing_time_ms = start.elapsed().as_millis() as u64;
    Json(BatchBacktestResponse {
        results,
        processing_time_ms,
    })
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
        // Keep a bounded working set for grouped multi-asset requests.
        trim_data_cache(&mut cache);
    }
    tracing::info!("Cached {} bars with ID: {}", bar_count, cache_id);
    Ok(Json(CacheDataResponse {
        cache_id,
        bar_count,
    }))
}
/// Cache several independent datasets in one request so a later grouped
/// backtest can reference them without retransmitting the OHLCV arrays.
pub async fn multi_cache_data_handler(
    State(state): State<AppState>,
    Json(req): Json<MultiAssetCacheRequest>,
) -> Result<Json<MultiAssetCacheResponse>, (StatusCode, String)> {
    let decoded = req
        .workloads
        .into_iter()
        .map(|workload| {
            let data = if !workload.data.is_empty() {
                workload.data
            } else if let Some(packed_data) = workload.packed_data {
                decode_packed_ohlcv(packed_data)
                    .map_err(|message| (StatusCode::BAD_REQUEST, message))?
            } else {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!("Multi-asset cache workload '{}' has no data", workload.id),
                ));
            };
            let data = Arc::new(data);
            let cache_id = cache_id_for_data(data.as_slice());
            Ok((workload.id, data, cache_id))
        })
        .collect::<Result<Vec<_>, (StatusCode, String)>>()?;

    let mut cache = state.data_cache.write().await;
    let mut datasets = Vec::with_capacity(decoded.len());
    for (id, data, cache_id) in decoded {
        let bar_count = data.len();
        cache.insert(
            cache_id.clone(),
            CachedDataset {
                data,
                last_access: next_cache_access(&state),
            },
        );
        datasets.push(MultiAssetCacheResult {
            id,
            cache_id,
            bar_count,
        });
    }
    trim_data_cache(&mut cache);
    Ok(Json(MultiAssetCacheResponse { datasets }))
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
    if values.len() % 6 != 0 {
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
fn decode_packed_signals(values: Vec<f64>) -> Result<Vec<Signal>, String> {
    if values.len() % 4 != 0 {
        return Err("Packed signal data length must be divisible by 4".to_string());
    }
    let mut signals = Vec::with_capacity(values.len() / 4);
    for row in values.chunks_exact(4) {
        if !row.iter().all(|value| value.is_finite()) {
            return Err("Packed signal data contains a non-finite value".to_string());
        }
        if row[0].fract() != 0.0
            || row[0] < i64::MIN as f64
            || row[0] > i64::MAX as f64
            || row[2].is_nan()
        {
            return Err("Packed signal data contains an invalid time or price".to_string());
        }
        let signal_type = match row[1] {
            0.0 => SignalType::Buy,
            1.0 => SignalType::Sell,
            _ => return Err("Packed signal data contains an invalid direction".to_string()),
        };
        let bar_index = if row[3] == -1.0 {
            None
        } else if row[3] >= 0.0 && row[3].fract() == 0.0 && row[3] <= usize::MAX as f64 {
            Some(row[3] as usize)
        } else {
            return Err("Packed signal data contains an invalid bar index".to_string());
        };
        signals.push(Signal {
            time: row[0] as Time,
            signal_type,
            price: row[2],
            bar_index,
            reason: None,
        });
    }
    Ok(signals)
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
    let market_series = build_market_series(data.as_slice());
    // Run all backtests in parallel using rayon
    let results: Vec<BatchBacktestResultItem> = req
        .items
        .par_iter()
        .map(|item| {
            let settings = item
                .settings
                .clone()
                .unwrap_or_else(|| req.base_settings.clone());
            let result = run_backtest_with_market_series(
                data.as_slice(),
                &item.signals,
                req.initial_capital,
                req.position_size_percent,
                req.commission_percent,
                &settings,
                Some(&req.sizing),
                req.compact,
                &market_series,
            );
            BatchBacktestResultItem {
                id: item.id.clone(),
                result,
            }
        })
        .collect();
    let processing_time_ms = start.elapsed().as_millis() as u64;
    tracing::info!(
        "Cached batch backtest: {} runs in {}ms",
        results.len(),
        processing_time_ms
    );
    Ok(Json(BatchBacktestResponse {
        results,
        processing_time_ms,
    }))
}
fn metric_summary_from_result(result: &BacktestResult) -> AssetOpportunityMetricSummary {
    AssetOpportunityMetricSummary {
        net_profit: result.net_profit,
        net_profit_percent: result.net_profit_percent,
        win_rate: result.win_rate,
        expectancy: result.expectancy,
        avg_trade: result.avg_trade,
        profit_factor: if result.profit_factor.is_finite() {
            Some(result.profit_factor)
        } else {
            None
        },
        max_drawdown: result.max_drawdown,
        max_drawdown_percent: result.max_drawdown_percent,
        total_trades: result.total_trades,
        winning_trades: result.winning_trades,
        losing_trades: result.losing_trades,
        avg_win: result.avg_win,
        avg_loss: result.avg_loss,
        sharpe_ratio: result.sharpe_ratio,
    }
}
fn metric_summary_from_trades(
    raw: &BacktestResult,
    trades: &[&Trade],
    initial_capital: f64,
) -> AssetOpportunityMetricSummary {
    let total_trades = trades.len() as u32;
    let winning_trades = trades.iter().filter(|trade| trade.pnl > 0.0).count() as u32;
    let losing_trades = total_trades.saturating_sub(winning_trades);
    let total_profit: f64 = trades
        .iter()
        .filter(|trade| trade.pnl > 0.0)
        .map(|trade| trade.pnl)
        .sum();
    let total_loss: f64 = trades
        .iter()
        .filter(|trade| trade.pnl <= 0.0)
        .map(|trade| trade.pnl.abs())
        .sum();
    let net_profit: f64 = trades.iter().map(|trade| trade.pnl).sum();
    let win_rate_fraction = if total_trades > 0 {
        winning_trades as f64 / total_trades as f64
    } else {
        0.0
    };
    let loss_rate_fraction = if total_trades > 0 {
        losing_trades as f64 / total_trades as f64
    } else {
        0.0
    };
    let avg_win = if winning_trades > 0 {
        total_profit / winning_trades as f64
    } else {
        0.0
    };
    let avg_loss = if losing_trades > 0 {
        total_loss / losing_trades as f64
    } else {
        0.0
    };
    let profit_factor = if total_loss > 0.0 {
        Some(total_profit / total_loss)
    } else if total_profit > 0.0 {
        None
    } else {
        Some(0.0)
    };
    AssetOpportunityMetricSummary {
        net_profit,
        net_profit_percent: if initial_capital > 0.0 {
            (net_profit / initial_capital) * 100.0
        } else {
            0.0
        },
        win_rate: win_rate_fraction * 100.0,
        expectancy: (win_rate_fraction * avg_win) - (loss_rate_fraction * avg_loss),
        avg_trade: if total_trades > 0 {
            net_profit / total_trades as f64
        } else {
            0.0
        },
        profit_factor,
        // Endpoint selection only removes terminal trade(s); the existing
        // TypeScript contract intentionally retains raw drawdown values.
        max_drawdown: raw.max_drawdown,
        max_drawdown_percent: raw.max_drawdown_percent,
        total_trades,
        winning_trades,
        losing_trades,
        avg_win,
        avg_loss,
        sharpe_ratio: selection_sharpe_ratio(trades, initial_capital),
    }
}
fn epoch_milliseconds(time: Time) -> f64 {
    let numeric = time as f64;
    if numeric.abs() < 1.0e11 {
        numeric * 1000.0
    } else {
        numeric
    }
}
fn selection_sharpe_ratio(trades: &[&Trade], initial_capital: f64) -> f64 {
    if trades.len() < 2 || !initial_capital.is_finite() || initial_capital <= 0.0 {
        return 0.0;
    }
    const MILLIS_PER_YEAR: f64 = 365.2425 * 24.0 * 60.0 * 60.0 * 1000.0;
    const MILLIS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
    let mut deltas = Vec::with_capacity(trades.len().saturating_sub(1));
    for pair in trades.windows(2) {
        let delta = epoch_milliseconds(pair[1].exit_time) - epoch_milliseconds(pair[0].exit_time);
        if delta > 0.0 && delta.is_finite() {
            deltas.push(delta);
        }
    }
    if deltas.is_empty() {
        return 0.0;
    }
    deltas.sort_by(|a, b| a.total_cmp(b));
    let median_delta = deltas[deltas.len() / 2];
    let periods_per_year = (MILLIS_PER_YEAR / median_delta).max(1.0);
    let collapse_intraday = MILLIS_PER_YEAR / periods_per_year < MILLIS_PER_DAY;
    let mut equity_samples: Vec<(Time, f64)> = Vec::with_capacity(trades.len());
    let mut equity = initial_capital;
    for trade in trades {
        equity += trade.pnl;
        if equity.is_finite() {
            equity_samples.push((trade.exit_time, equity));
        }
    }
    if collapse_intraday {
        let mut collapsed: Vec<(i64, f64)> = Vec::new();
        for (time, value) in equity_samples {
            let day = (epoch_milliseconds(time) / MILLIS_PER_DAY).floor() as i64;
            if let Some(last) = collapsed.last_mut() {
                if last.0 == day {
                    last.1 = value;
                    continue;
                }
            }
            collapsed.push((day, value));
        }
        equity_samples = collapsed
            .into_iter()
            .map(|(day, value)| ((day * 86_400) as Time, value))
            .collect();
    }
    let mut returns = Vec::with_capacity(equity_samples.len().saturating_sub(1));
    for pair in equity_samples.windows(2) {
        if pair[0].1 > 0.0 && pair[0].1.is_finite() && pair[1].1.is_finite() {
            returns.push((pair[1].1 - pair[0].1) / pair[0].1);
        }
    }
    if returns.len() < 5 {
        return 0.0;
    }
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let variance = returns
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        / (returns.len() - 1) as f64;
    let std_dev = variance.max(0.0).sqrt();
    if !std_dev.is_finite() || std_dev < 1.0e-4 {
        return 0.0;
    }
    ((mean / std_dev) * periods_per_year.sqrt()).clamp(-8.0, 8.0)
}
fn summarize_asset_opportunity_result(
    result: BacktestResult,
    id: String,
    last_data_time: Option<Time>,
    initial_capital: f64,
) -> AssetOpportunityBatchResultItem {
    let raw_summary = metric_summary_from_result(&result);
    let Some(last_data_time) = last_data_time else {
        return AssetOpportunityBatchResultItem {
            id,
            result: raw_summary.clone(),
            selection_result: raw_summary,
            endpoint_adjusted: false,
            endpoint_removed_trades: 0,
        };
    };
    let filtered: Vec<&Trade> = result
        .trades
        .iter()
        .filter(|trade| trade.exit_time < last_data_time)
        .collect();
    let removed = result.trades.len().saturating_sub(filtered.len());
    let selection_result = if removed > 0 {
        metric_summary_from_trades(&result, &filtered, initial_capital)
    } else {
        raw_summary.clone()
    };
    AssetOpportunityBatchResultItem {
        id,
        result: raw_summary,
        selection_result,
        endpoint_adjusted: removed > 0,
        endpoint_removed_trades: removed,
    }
}
fn summarize_fresh_entry_result(result: BacktestResult) -> FreshEntrySummary {
    let is_open = result.final_position_open;
    let latest_trade = result.trades.last().map(|trade| FreshEntryTradeSummary {
        trade_type: trade.trade_type,
        entry_time: trade.entry_time,
        entry_price: trade.entry_price,
        exit_reason: if is_open {
            "end_of_data".to_string()
        } else {
            "signal".to_string()
        },
    });
    FreshEntrySummary {
        total_trades: result.total_trades,
        latest_trade,
        is_open,
    }
}
fn run_fresh_entry_batch(
    data: &[OHLCV],
    items: &[crate::types::BatchBacktestItem],
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
    base_settings: crate::types::BacktestSettings,
    sizing: crate::types::TradeSizingConfig,
) -> FreshEntryBatchResponse {
    let start = Instant::now();
    let market_series = build_market_series(data);
    let results: Vec<FreshEntryBatchResultItem> = items
        .par_iter()
        .map(|item| {
            let settings = item
                .settings
                .clone()
                .unwrap_or_else(|| base_settings.clone());
            let result = run_backtest_with_market_series_options(
                data,
                &item.signals,
                initial_capital,
                position_size_percent,
                commission_percent,
                &settings,
                Some(&sizing),
                true,
                true,
                &market_series,
            );
            FreshEntryBatchResultItem {
                id: item.id.clone(),
                result: summarize_fresh_entry_result(result),
            }
        })
        .collect();
    FreshEntryBatchResponse {
        results,
        processing_time_ms: start.elapsed().as_millis() as u64,
    }
}
/// Handle fresh-entry backtest summaries without returning full trade history.
pub async fn fresh_entry_batch_handler(
    Json(req): Json<BatchBacktestRequest>,
) -> Json<FreshEntryBatchResponse> {
    Json(run_fresh_entry_batch(
        &req.data,
        &req.items,
        req.initial_capital,
        req.position_size_percent,
        req.commission_percent,
        req.base_settings,
        req.sizing,
    ))
}
/// Handle cached fresh-entry backtest summaries.
pub async fn cached_fresh_entry_batch_handler(
    State(state): State<AppState>,
    Json(req): Json<CachedBatchBacktestRequest>,
) -> Result<Json<FreshEntryBatchResponse>, (StatusCode, String)> {
    let data = get_cached_dataset(&state, &req.cache_id).await;
    let Some(data) = data else {
        return Err((
            StatusCode::NOT_FOUND,
            format!(
                "Cache ID '{}' not found. Upload data first via /api/data/cache",
                req.cache_id
            ),
        ));
    };
    Ok(Json(run_fresh_entry_batch(
        data.as_slice(),
        &req.items,
        req.initial_capital,
        req.position_size_percent,
        req.commission_percent,
        req.base_settings,
        req.sizing,
    )))
}
fn run_asset_opportunity_batch(
    data: &[OHLCV],
    items: &[crate::types::BatchBacktestItem],
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
    base_settings: crate::types::BacktestSettings,
    sizing: crate::types::TradeSizingConfig,
    last_data_time: Option<Time>,
) -> AssetOpportunityBatchResponse {
    let start = Instant::now();
    let market_series = build_market_series(data);
    let results: Vec<AssetOpportunityBatchResultItem> = items
        .par_iter()
        .map(|item| {
            let settings = item
                .settings
                .clone()
                .unwrap_or_else(|| base_settings.clone());
            let result = run_backtest_with_market_series_options(
                data,
                &item.signals,
                initial_capital,
                position_size_percent,
                commission_percent,
                &settings,
                Some(&sizing),
                true,
                true,
                &market_series,
            );
            summarize_asset_opportunity_result(
                result,
                item.id.clone(),
                last_data_time,
                initial_capital,
            )
        })
        .collect();
    AssetOpportunityBatchResponse {
        results,
        processing_time_ms: start.elapsed().as_millis() as u64,
        cache_ids: Vec::new(),
    }
}
/// Handle Asset Opportunity batch backtests without returning trade history.
pub async fn asset_opportunity_batch_handler(
    Json(req): Json<BatchBacktestRequest>,
) -> Json<AssetOpportunityBatchResponse> {
    Json(run_asset_opportunity_batch(
        &req.data,
        &req.items,
        req.initial_capital,
        req.position_size_percent,
        req.commission_percent,
        req.base_settings,
        req.sizing,
        req.last_data_time,
    ))
}
/// Handle cached Asset Opportunity batch backtests without returning history.
pub async fn cached_asset_opportunity_batch_handler(
    State(state): State<AppState>,
    Json(req): Json<CachedBatchBacktestRequest>,
) -> Result<Json<AssetOpportunityBatchResponse>, (StatusCode, String)> {
    let data = get_cached_dataset(&state, &req.cache_id).await;
    let Some(data) = data else {
        return Err((
            StatusCode::NOT_FOUND,
            format!(
                "Cache ID '{}' not found. Upload data first via /api/data/cache",
                req.cache_id
            ),
        ));
    };
    Ok(Json(run_asset_opportunity_batch(
        data.as_slice(),
        &req.items,
        req.initial_capital,
        req.position_size_percent,
        req.commission_percent,
        req.base_settings,
        req.sizing,
        req.last_data_time,
    )))
}
struct ResolvedMultiAssetWorkload {
    data: Arc<Vec<OHLCV>>,
    items: Vec<crate::types::BatchBacktestItem>,
    last_data_time: Option<Time>,
    data_end_index: Option<usize>,
}
struct DecodedMultiAssetWorkload {
    id: String,
    data: Option<Arc<Vec<OHLCV>>>,
    items: Vec<crate::types::BatchBacktestItem>,
    last_data_time: Option<Time>,
    cache_id: Option<String>,
    generated_cache_id: Option<String>,
    data_end_index: Option<usize>,
}
struct MultiAssetWorkloadContext<'a> {
    data: &'a [OHLCV],
    market_series: crate::backtest::MarketSeries,
    last_data_time: Option<Time>,
}
async fn resolve_multi_asset_workloads(
    state: &AppState,
    workloads: Vec<crate::types::MultiAssetBatchWorkload>,
) -> Result<(Vec<ResolvedMultiAssetWorkload>, Vec<MultiAssetCacheResult>), (StatusCode, String)> {
    // Decode request-owned payloads before taking the shared cache lock. This
    // keeps packed OHLCV/signal decoding from blocking unrelated requests.
    let decoded = workloads
        .into_iter()
        .map(|workload| {
            let crate::types::MultiAssetBatchWorkload {
                id,
                data,
                packed_data,
                items,
                last_data_time,
                cache_id,
                data_end_index,
            } = workload;
            let data = if !data.is_empty() {
                Some(Arc::new(data))
            } else if let Some(packed_data) = packed_data {
                Some(Arc::new(
                    decode_packed_ohlcv(packed_data)
                        .map_err(|message| (StatusCode::BAD_REQUEST, message))?,
                ))
            } else {
                None
            };
            let generated_cache_id = if cache_id.is_none() {
                data.as_ref().map(|data| cache_id_for_data(data.as_slice()))
            } else {
                None
            };
            let items = items
                .into_iter()
                .map(|mut item| {
                    if let Some(packed_signals) = item.packed_signals.take() {
                        item.signals =
                            decode_packed_signals(packed_signals).map_err(|message| {
                                (
                                    StatusCode::BAD_REQUEST,
                                    format!(
                                        "Workload '{}' has invalid packed signals: {message}",
                                        id
                                    ),
                                )
                            })?;
                    }
                    Ok(item)
                })
                .collect::<Result<Vec<_>, (StatusCode, String)>>()?;
            Ok(DecodedMultiAssetWorkload {
                id,
                data,
                items,
                last_data_time,
                cache_id,
                generated_cache_id,
                data_end_index,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut cache = state.data_cache.write().await;
    let mut cache_ids = Vec::new();
    let mut resolved = Vec::with_capacity(decoded.len());
    for workload in decoded {
        let data = if let Some(data) = workload.data {
            data
        } else if let Some(cache_id) = workload.cache_id.as_deref() {
            let access = next_cache_access(state);
            let Some(entry) = cache.get_mut(cache_id) else {
                return Err((
                    StatusCode::NOT_FOUND,
                    format!(
                        "Cache ID '{}' not found. Upload data first via /api/data/cache",
                        cache_id
                    ),
                ));
            };
            entry.last_access = access;
            entry.data.clone()
        } else {
            return Err((
                StatusCode::BAD_REQUEST,
                format!(
                    "Multi-asset workload '{}' has no data or cacheId",
                    workload.id
                ),
            ));
        };
        if let Some(cache_id) = workload.generated_cache_id {
            cache.insert(
                cache_id.clone(),
                CachedDataset {
                    data: data.clone(),
                    last_access: next_cache_access(state),
                },
            );
            cache_ids.push(MultiAssetCacheResult {
                id: workload.id.clone(),
                cache_id,
                bar_count: data.len(),
            });
        }
        if let Some(end) = workload.data_end_index {
            if end == 0 || end > data.len() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "Multi-asset workload '{}' has an invalid dataEndIndex",
                        workload.id
                    ),
                ));
            }
        }
        resolved.push(ResolvedMultiAssetWorkload {
            data,
            items: workload.items,
            last_data_time: workload.last_data_time,
            data_end_index: workload.data_end_index,
        });
    }
    trim_data_cache(&mut cache);
    Ok((resolved, cache_ids))
}
/// Run Asset Opportunity summaries for several independent datasets in one
/// request. The workload boundary prevents candles from different assets from
/// sharing a market series while Rayon parallelizes the asset work.
pub async fn multi_asset_opportunity_batch_handler(
    State(state): State<AppState>,
    Json(req): Json<MultiAssetBatchBacktestRequest>,
) -> Result<Json<AssetOpportunityBatchResponse>, (StatusCode, String)> {
    let start = Instant::now();
    let (workloads, cache_ids) = resolve_multi_asset_workloads(&state, req.workloads).await?;
    let contexts: Vec<MultiAssetWorkloadContext<'_>> = workloads
        .par_iter()
        .map(|workload| {
            let end = workload.data_end_index.unwrap_or(workload.data.len());
            let data = &workload.data[..end];
            MultiAssetWorkloadContext {
                data,
                market_series: build_market_series(data),
                last_data_time: workload.last_data_time,
            }
        })
        .collect();
    let results: Vec<AssetOpportunityBatchResultItem> = contexts
        .par_iter()
        .zip(workloads.par_iter())
        .flat_map(|(context, workload)| {
            workload.items.par_iter().map(|item| {
                let settings = item
                    .settings
                    .clone()
                    .unwrap_or_else(|| req.base_settings.clone());
                let result = run_backtest_with_market_series_options(
                    context.data,
                    &item.signals,
                    req.initial_capital,
                    req.position_size_percent,
                    req.commission_percent,
                    &settings,
                    Some(&req.sizing),
                    true,
                    true,
                    &context.market_series,
                );
                summarize_asset_opportunity_result(
                    result,
                    item.id.clone(),
                    context.last_data_time,
                    req.initial_capital,
                )
            })
        })
        .collect();
    Ok(Json(AssetOpportunityBatchResponse {
        results,
        processing_time_ms: start.elapsed().as_millis() as u64,
        cache_ids,
    }))
}
/// Run fresh-entry summaries for several independent datasets in one request.
pub async fn multi_asset_fresh_entry_batch_handler(
    State(state): State<AppState>,
    Json(req): Json<MultiAssetBatchBacktestRequest>,
) -> Result<Json<FreshEntryBatchResponse>, (StatusCode, String)> {
    let start = Instant::now();
    let (workloads, _) = resolve_multi_asset_workloads(&state, req.workloads).await?;
    let results: Vec<FreshEntryBatchResultItem> = workloads
        .par_iter()
        .flat_map(|workload| {
            let end = workload.data_end_index.unwrap_or(workload.data.len());
            let data = &workload.data[..end];
            let market_series = build_market_series(data);
            workload
                .items
                .iter()
                .map(|item| {
                    let settings = item
                        .settings
                        .clone()
                        .unwrap_or_else(|| req.base_settings.clone());
                    let result = run_backtest_with_market_series_options(
                        data,
                        &item.signals,
                        req.initial_capital,
                        req.position_size_percent,
                        req.commission_percent,
                        &settings,
                        Some(&req.sizing),
                        true,
                        true,
                        &market_series,
                    );
                    FreshEntryBatchResultItem {
                        id: item.id.clone(),
                        result: summarize_fresh_entry_result(result),
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect();
    Ok(Json(FreshEntryBatchResponse {
        results,
        processing_time_ms: start.elapsed().as_millis() as u64,
    }))
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
/// Handle walk-forward request (placeholder)
pub async fn walk_forward_handler(
    Json(_req): Json<WalkForwardRequest>,
) -> Result<Json<WalkForwardResult>, (StatusCode, String)> {
    Err((
        StatusCode::NOT_IMPLEMENTED,
        "Rust walk-forward requires a native strategy registry and is not implemented yet."
            .to_string(),
    ))
}
/// Handle finder request (placeholder)
pub async fn finder_handler(
    Json(_req): Json<FinderRequest>,
) -> Result<Json<Vec<FinderResult>>, (StatusCode, String)> {
    Err((
        StatusCode::NOT_IMPLEMENTED,
        "Rust finder requires a native strategy registry and is not implemented yet.".to_string(),
    ))
}
/// WebSocket handler for progress streaming
pub async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_socket)
}
async fn handle_socket(mut socket: WebSocket) {
    use axum::extract::ws::Message;
    // Send initial connection message
    let msg = ProgressUpdate {
        percent: 0.0,
        status: "Connected".to_string(),
        current_window: None,
        total_windows: None,
    };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = socket.send(Message::Text(json)).await;
    }
    // Keep connection alive
    while let Some(Ok(msg)) = socket.recv().await {
        if let Message::Close(_) = msg {
            break;
        }
    }
}
/// Proxy handler for external API requests (avoids CORS issues)
/// This allows the frontend to make requests to external APIs through our server
pub async fn proxy_handler(
    Json(req): Json<ProxyRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Validate URL to prevent abuse
    let allowed_hosts = [
        "api.twelvedata.com",
        "query1.finance.yahoo.com",
        "query2.finance.yahoo.com",
        "api.binance.com",
    ];
    let url = match reqwest::Url::parse(&req.url) {
        Ok(u) => u,
        Err(_) => return Err((StatusCode::BAD_REQUEST, "Invalid URL".to_string())),
    };
    if let Some(host) = url.host_str() {
        if !allowed_hosts.iter().any(|&h| host == h) {
            return Err((
                StatusCode::FORBIDDEN,
                format!("Host '{}' is not allowed", host),
            ));
        }
    } else {
        return Err((StatusCode::BAD_REQUEST, "No host in URL".to_string()));
    }
    tracing::debug!("Proxying request to: {}", req.url);
    // Make the request
    let client = reqwest::Client::new();
    let response = match client.get(&req.url).send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Proxy request failed: {}", e);
            return Err((StatusCode::BAD_GATEWAY, format!("Failed to fetch: {}", e)));
        }
    };
    // Check status
    if !response.status().is_success() {
        return Err((
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            format!("External API returned status: {}", response.status()),
        ));
    }
    // Parse JSON response
    let data = match response.json::<serde_json::Value>().await {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("Failed to parse JSON: {}", e);
            return Err((
                StatusCode::BAD_GATEWAY,
                "Failed to parse response".to_string(),
            ));
        }
    };
    Ok(Json(data))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        }
    }

    #[tokio::test]
    async fn generic_backtest_route_honors_output_options() {
        let full = backtest_handler(Json(make_backtest_request(false, false)))
            .await
            .0;
        assert!(!full.equity_curve.is_empty());
        assert_eq!(full.trades.len(), 1);

        let compact = backtest_handler(Json(make_backtest_request(true, false)))
            .await
            .0;
        assert!(compact.equity_curve.is_empty());
        assert!(compact.trades.is_empty());
        assert_eq!(compact.total_trades, full.total_trades);

        let compact_with_trades = backtest_handler(Json(make_backtest_request(true, true)))
            .await
            .0;
        assert!(compact_with_trades.equity_curve.is_empty());
        assert_eq!(compact_with_trades.trades.len(), 1);
        assert_eq!(compact_with_trades.total_trades, full.total_trades);
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
