//! Strategy Finder
//!
//! Grid and random search for optimal strategy parameters.
use crate::backtest::run_backtest;
use crate::types::{
    BacktestResult, BacktestSettings, FinderMetric, FinderMode, FinderOptions, FinderResult,
    Signal, StrategyParams, OHLCV,
};
use rand::Rng;
use rayon::prelude::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
/// Strategy finder runner
///
/// Part of the public library API for external consumers.
#[allow(dead_code)]
pub struct FinderRunner {
    options: FinderOptions,
    settings: BacktestSettings,
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
}
impl FinderRunner {
    pub fn new(
        options: FinderOptions,
        settings: BacktestSettings,
        initial_capital: f64,
        position_size_percent: f64,
        commission_percent: f64,
    ) -> Self {
        Self {
            options,
            settings,
            initial_capital,
            position_size_percent,
            commission_percent,
        }
    }
    /// Run strategy finder
    pub fn run(
        &self,
        data: &[OHLCV],
        generate_signals: impl Fn(&[OHLCV], &StrategyParams) -> Vec<Signal> + Sync,
        base_params: &StrategyParams,
        strategy_name: &str,
        progress_callback: Option<impl Fn(f64, &str) + Sync>,
    ) -> Vec<FinderResult> {
        // Generate parameter combinations
        let param_sets = match self.options.mode {
            FinderMode::Grid => self.generate_grid_combos(base_params),
            FinderMode::Random => self.generate_random_combos(base_params),
        };
        let total = param_sets.len();
        if total == 0 {
            return vec![];
        }
        // Progress tracking
        let completed = Arc::new(AtomicUsize::new(0));
        // Parallel evaluation
        let mut results: Vec<FinderResult> = param_sets
            .par_iter()
            .filter_map(|params| {
                let signals = generate_signals(data, params);
                let result = run_backtest(
                    data,
                    &signals,
                    self.initial_capital,
                    self.position_size_percent,
                    self.commission_percent,
                    &self.settings,
                    None, // Use percentage sizing for optimization
                    false,
                );
                // Apply trade filter
                if self.options.trade_filter_enabled
                    && (result.total_trades < self.options.min_trades
                        || result.total_trades > self.options.max_trades)
                {
                    return None;
                }
                // Update progress
                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(ref cb) = progress_callback {
                    let pct = (done as f64 / total as f64) * 100.0;
                    cb(pct, &format!("{}/{} combinations", done, total));
                }
                let key = self.serialize_params(params);
                Some(FinderResult {
                    key,
                    name: strategy_name.to_string(),
                    params: params.clone(),
                    result,
                })
            })
            .collect();
        // Sort by priority
        self.sort_results(&mut results);
        // Return top N
        results.truncate(self.options.top_n);
        results
    }
    /// Generate grid search combinations
    fn generate_grid_combos(&self, base_params: &StrategyParams) -> Vec<StrategyParams> {
        let mut combos = Vec::new();
        let mut seen = std::collections::HashSet::new();
        // Get parameter keys from base params
        let keys: Vec<String> = base_params.keys().cloned().collect();
        // Build values for each key
        let values_by_key: Vec<Vec<f64>> = keys
            .iter()
            .map(|key| {
                let base_value = *base_params.get(key).unwrap_or(&0.0);
                self.build_range_values(key, base_value)
            })
            .collect();
        // Generate combinations recursively
        self.build_combos(
            &keys,
            &values_by_key,
            0,
            base_params.clone(),
            &mut combos,
            &mut seen,
        );
        combos.truncate(self.options.max_runs);
        combos
    }
    fn build_combos(
        &self,
        keys: &[String],
        values_by_key: &[Vec<f64>],
        key_index: usize,
        current: StrategyParams,
        combos: &mut Vec<StrategyParams>,
        seen: &mut std::collections::HashSet<String>,
    ) {
        if combos.len() >= self.options.max_runs {
            return;
        }
        if key_index >= keys.len() {
            let serialized = self.serialize_params(&current);
            if !seen.contains(&serialized) {
                seen.insert(serialized);
                combos.push(current);
            }
            return;
        }
        let key = &keys[key_index];
        let values = &values_by_key[key_index];
        for &value in values {
            let mut next = current.clone();
            next.insert(key.clone(), value);
            self.build_combos(keys, values_by_key, key_index + 1, next, combos, seen);
        }
    }
    /// Generate random combinations
    fn generate_random_combos(&self, base_params: &StrategyParams) -> Vec<StrategyParams> {
        let mut rng = rand::thread_rng();
        let mut combos = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let keys: Vec<String> = base_params.keys().cloned().collect();
        while combos.len() < self.options.max_runs && combos.len() < 10000 {
            let mut params = base_params.clone();
            for key in &keys {
                let base_value = *base_params.get(key).unwrap_or(&0.0);
                // Skip toggle params (0 or 1)
                if self.is_toggle_param(key, base_value) {
                    let toggle: bool = rng.gen();
                    params.insert(key.clone(), if toggle { 1.0 } else { 0.0 });
                    continue;
                }
                // Generate random value within range
                let range_factor = self.options.range_percent / 100.0;
                let min_val = base_value * (1.0 - range_factor);
                let max_val = base_value * (1.0 + range_factor);
                let random_val: f64 = rng.gen_range(min_val..=max_val);
                // Round to reasonable precision
                let rounded = (random_val * 1000.0).round() / 1000.0;
                params.insert(key.clone(), rounded);
            }
            let serialized = self.serialize_params(&params);
            if !seen.contains(&serialized) {
                seen.insert(serialized);
                combos.push(params);
            }
        }
        combos
    }
    /// Build value range for a parameter
    fn build_range_values(&self, _key: &str, base_value: f64) -> Vec<f64> {
        let mut values = vec![base_value];
        let steps = self.options.steps;
        let range_factor = self.options.range_percent / 100.0;
        let step_size = if base_value == 0.0 {
            0.1 // Default step for zero base
        } else {
            (base_value * range_factor * 2.0) / steps as f64
        };
        let min_val = base_value - (base_value * range_factor);
        let max_val = base_value + (base_value * range_factor);
        let mut val = min_val;
        while val <= max_val {
            if val != base_value {
                values.push((val * 1000.0).round() / 1000.0);
            }
            val += step_size;
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        values.dedup();
        values
    }
    /// Check if parameter is a toggle (on/off)
    fn is_toggle_param(&self, key: &str, value: f64) -> bool {
        key.starts_with("use") && (value == 0.0 || value == 1.0)
    }
    /// Serialize parameters for deduplication
    fn serialize_params(&self, params: &StrategyParams) -> String {
        let mut pairs: Vec<_> = params.iter().collect();
        pairs.sort_by_key(|(k, _)| *k);
        pairs
            .iter()
            .map(|(k, v)| format!("{}:{:.4}", k, v))
            .collect::<Vec<_>>()
            .join("|")
    }
    /// Sort results by priority metrics
    fn sort_results(&self, results: &mut [FinderResult]) {
        if self.options.sort_priority.is_empty() {
            // Default: sort by net profit
            results.sort_by(|a, b| {
                b.result
                    .net_profit
                    .partial_cmp(&a.result.net_profit)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            return;
        }
        // Multi-key sort by priority
        results.sort_by(|a, b| {
            for metric in &self.options.sort_priority {
                let cmp = self.compare_by_metric(&a.result, &b.result, metric);
                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
            }
            std::cmp::Ordering::Equal
        });
    }
    /// Compare two results by a specific metric
    fn compare_by_metric(
        &self,
        a: &BacktestResult,
        b: &BacktestResult,
        metric: &FinderMetric,
    ) -> std::cmp::Ordering {
        let (val_a, val_b, higher_is_better) = match metric {
            FinderMetric::NetProfit => (a.net_profit, b.net_profit, true),
            FinderMetric::ProfitFactor => (a.profit_factor, b.profit_factor, true),
            FinderMetric::SharpeRatio => (a.sharpe_ratio, b.sharpe_ratio, true),
            FinderMetric::WinRate => (a.win_rate, b.win_rate, true),
            FinderMetric::MaxDrawdownPercent => {
                (a.max_drawdown_percent, b.max_drawdown_percent, false)
            }
            FinderMetric::Expectancy => (a.expectancy, b.expectancy, true),
            FinderMetric::AverageGain => (a.avg_win, b.avg_win, true),
            FinderMetric::TotalTrades => (a.total_trades as f64, b.total_trades as f64, true),
            FinderMetric::NetProfitPercent => (a.net_profit_percent, b.net_profit_percent, true),
        };
        if higher_is_better {
            val_b
                .partial_cmp(&val_a)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            val_a
                .partial_cmp(&val_b)
                .unwrap_or(std::cmp::Ordering::Equal)
        }
    }
}
/// Convenience function for strategy finder
#[allow(clippy::too_many_arguments)]
pub fn run_finder(
    data: &[OHLCV],
    generate_signals: impl Fn(&[OHLCV], &StrategyParams) -> Vec<Signal> + Sync,
    base_params: &StrategyParams,
    strategy_name: &str,
    options: FinderOptions,
    settings: BacktestSettings,
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
) -> Vec<FinderResult> {
    let runner = FinderRunner::new(
        options,
        settings,
        initial_capital,
        position_size_percent,
        commission_percent,
    );
    runner.run(
        data,
        generate_signals,
        base_params,
        strategy_name,
        None::<fn(f64, &str)>,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_build_range_values() {
        let options = FinderOptions {
            mode: FinderMode::Grid,
            sort_priority: vec![],
            use_advanced_sort: false,
            top_n: 10,
            steps: 3,
            range_percent: 50.0,
            max_runs: 100,
            trade_filter_enabled: false,
            min_trades: 10,
            max_trades: u32::MAX,
        };
        let runner = FinderRunner::new(options, BacktestSettings::default(), 10000.0, 2.0, 0.1);
        let values = runner.build_range_values("period", 10.0);
        // Should have base value plus steps
        assert!(values.len() > 1);
        assert!(values.contains(&10.0));
    }
    #[test]
    fn test_serialize_params() {
        let options = FinderOptions {
            mode: FinderMode::Grid,
            sort_priority: vec![],
            use_advanced_sort: false,
            top_n: 10,
            steps: 5,
            range_percent: 50.0,
            max_runs: 100,
            trade_filter_enabled: false,
            min_trades: 10,
            max_trades: u32::MAX,
        };
        let runner = FinderRunner::new(options, BacktestSettings::default(), 10000.0, 2.0, 0.1);
        let mut params = StrategyParams::new();
        params.insert("a".to_string(), 1.0);
        params.insert("b".to_string(), 2.0);
        let serialized = runner.serialize_params(&params);
        // Should be deterministic regardless of insertion order
        assert!(serialized.contains("a:1.0000"));
        assert!(serialized.contains("b:2.0000"));
    }
}
