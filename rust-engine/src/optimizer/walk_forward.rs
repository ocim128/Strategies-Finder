//! Walk-Forward Optimization
//!
//! Parallel walk-forward analysis using Rayon for multi-core optimization.
use crate::backtest::run_backtest;
use crate::indicators::{IndicatorPeriods, PrecomputedIndicators};
use crate::types::{
    BacktestResult, BacktestSettings, Signal, StrategyParams, WalkForwardConfig, WalkForwardResult,
    WalkForwardWindow, OHLCV,
};
use rayon::prelude::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
/// Walk-forward analysis runner
///
/// Part of the public library API for external consumers.
#[allow(dead_code)]
pub struct WalkForwardRunner {
    config: WalkForwardConfig,
    settings: BacktestSettings,
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
}
impl WalkForwardRunner {
    pub fn new(
        config: WalkForwardConfig,
        settings: BacktestSettings,
        initial_capital: f64,
        position_size_percent: f64,
        commission_percent: f64,
    ) -> Self {
        Self {
            config,
            settings,
            initial_capital,
            position_size_percent,
            commission_percent,
        }
    }
    /// Run walk-forward analysis
    pub fn run(
        &self,
        data: &[OHLCV],
        generate_signals: impl Fn(&[OHLCV], &StrategyParams) -> Vec<Signal> + Sync,
        base_params: &StrategyParams,
        progress_callback: Option<impl Fn(f64, &str) + Sync>,
    ) -> WalkForwardResult {
        let start_time = std::time::Instant::now();
        // Generate windows
        let windows = self.generate_windows(data.len());
        let total_windows = windows.len();
        if total_windows == 0 {
            return self.empty_result();
        }
        // Pre-compute indicators for entire dataset
        let periods = IndicatorPeriods::from_settings(&self.settings);
        let indicators = PrecomputedIndicators::compute_all(data, &periods);
        let indicators = Arc::new(indicators);
        // Progress tracking
        let completed = Arc::new(AtomicUsize::new(0));
        let completed_ref = completed.clone();
        // Parallel window optimization
        let window_results: Vec<WalkForwardWindow> = windows
            .par_iter()
            .enumerate()
            .map(|(idx, window)| {
                // Optimize on in-sample period
                let is_data = &data[window.0..window.1];
                let best_params =
                    self.optimize_window(is_data, &generate_signals, base_params, &indicators);
                // Test on out-of-sample period
                let oos_data = &data[window.2..window.3];
                let oos_signals = generate_signals(oos_data, &best_params);
                let oos_result = run_backtest(
                    oos_data,
                    &oos_signals,
                    self.initial_capital,
                    self.position_size_percent,
                    self.commission_percent,
                    &self.settings,
                    None, // Use percentage sizing for optimization
                    false,
                );
                // In-sample result for comparison
                let is_signals = generate_signals(is_data, &best_params);
                let is_result = run_backtest(
                    is_data,
                    &is_signals,
                    self.initial_capital,
                    self.position_size_percent,
                    self.commission_percent,
                    &self.settings,
                    None, // Use percentage sizing for optimization
                    false,
                );
                // Update progress
                let done = completed_ref.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(ref cb) = progress_callback {
                    let pct = (done as f64 / total_windows as f64) * 100.0;
                    cb(pct, &format!("Window {}/{}", done, total_windows));
                }
                // Calculate degradation metrics
                let sharpe_degradation = is_result.sharpe_ratio - oos_result.sharpe_ratio;
                let perf_degradation = if is_result.net_profit_percent != 0.0 {
                    ((is_result.net_profit_percent - oos_result.net_profit_percent)
                        / is_result.net_profit_percent.abs())
                        * 100.0
                } else {
                    0.0
                };
                WalkForwardWindow {
                    window_index: idx,
                    optimization_start: window.0,
                    optimization_end: window.1,
                    test_start: window.2,
                    test_end: window.3,
                    optimized_params: best_params,
                    in_sample_result: is_result,
                    out_of_sample_result: oos_result,
                    sharpe_degradation,
                    performance_degradation_percent: perf_degradation,
                }
            })
            .collect();
        // Aggregate results
        let optimization_time_ms = start_time.elapsed().as_millis() as u64;
        self.aggregate_results(window_results, optimization_time_ms)
    }
    /// Generate walk-forward windows
    fn generate_windows(&self, data_len: usize) -> Vec<(usize, usize, usize, usize)> {
        let mut windows = Vec::new();
        let total_window = self.config.optimization_window + self.config.test_window;
        let mut start = 0;
        while start + total_window <= data_len {
            let opt_end = start + self.config.optimization_window;
            let test_end = opt_end + self.config.test_window;
            windows.push((start, opt_end, opt_end, test_end));
            start += self.config.step_size;
        }
        windows
    }
    /// Optimize parameters on a single window
    fn optimize_window(
        &self,
        data: &[OHLCV],
        generate_signals: &(impl Fn(&[OHLCV], &StrategyParams) -> Vec<Signal> + Sync),
        base_params: &StrategyParams,
        _indicators: &PrecomputedIndicators,
    ) -> StrategyParams {
        // Generate parameter grid
        let param_grid = self.generate_param_grid(base_params);
        if param_grid.is_empty() {
            return base_params.clone();
        }
        // Find best parameters
        let best = param_grid
            .par_iter()
            .map(|params| {
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
                let score = self.calculate_score(&result);
                (params.clone(), score)
            })
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        best.map(|(p, _)| p).unwrap_or_else(|| base_params.clone())
    }
    /// Generate parameter grid from ranges
    fn generate_param_grid(&self, base_params: &StrategyParams) -> Vec<StrategyParams> {
        let mut grid = vec![base_params.clone()];
        for range in &self.config.parameter_ranges {
            let mut new_grid = Vec::new();
            let mut value = range.min;
            while value <= range.max {
                for params in &grid {
                    let mut new_params = params.clone();
                    new_params.insert(range.name.clone(), value);
                    new_grid.push(new_params);
                }
                value += range.step;
            }
            grid = new_grid;
        }
        grid
    }
    /// Calculate optimization score for a backtest result
    fn calculate_score(&self, result: &BacktestResult) -> f64 {
        if result.total_trades < self.config.min_trades {
            return -1000.0;
        }
        // Composite score: Sharpe-weighted profit factor
        let sharpe_weight = result.sharpe_ratio.max(0.0);
        let pf_weight = result.profit_factor.min(10.0).max(0.0);
        let dd_penalty = result.max_drawdown_percent / 100.0;
        (sharpe_weight * 0.4 + pf_weight * 0.3 + result.win_rate * 0.3) * (1.0 - dd_penalty * 0.5)
    }
    /// Aggregate window results into final result
    fn aggregate_results(
        &self,
        windows: Vec<WalkForwardWindow>,
        time_ms: u64,
    ) -> WalkForwardResult {
        if windows.is_empty() {
            return self.empty_result();
        }
        let total_windows = windows.len();
        // Average metrics
        let avg_is_sharpe = windows
            .iter()
            .map(|w| w.in_sample_result.sharpe_ratio)
            .sum::<f64>()
            / total_windows as f64;
        let avg_oos_sharpe = windows
            .iter()
            .map(|w| w.out_of_sample_result.sharpe_ratio)
            .sum::<f64>()
            / total_windows as f64;
        // Walk-forward efficiency
        let efficiency = if avg_is_sharpe != 0.0 {
            (avg_oos_sharpe / avg_is_sharpe) * 100.0
        } else {
            0.0
        };
        // Parameter stability (lower is better)
        let param_stability = self.calculate_parameter_stability(&windows);
        // Robustness score
        let robustness =
            self.calculate_robustness(avg_is_sharpe, avg_oos_sharpe, param_stability, &windows);
        // Combine all OOS trades
        let combined_oos = self.combine_oos_results(&windows);
        WalkForwardResult {
            windows,
            combined_oos_trades: combined_oos,
            avg_in_sample_sharpe: avg_is_sharpe,
            avg_out_of_sample_sharpe: avg_oos_sharpe,
            walk_forward_efficiency: efficiency,
            robustness_score: robustness,
            total_windows,
            optimization_time_ms: time_ms,
            parameter_stability: param_stability,
        }
    }
    /// Calculate parameter stability across windows
    fn calculate_parameter_stability(&self, windows: &[WalkForwardWindow]) -> f64 {
        if windows.len() < 2 || self.config.parameter_ranges.is_empty() {
            return 100.0;
        }
        let mut total_cv = 0.0;
        let mut count = 0;
        for range in &self.config.parameter_ranges {
            let values: Vec<f64> = windows
                .iter()
                .filter_map(|w| w.optimized_params.get(&range.name).copied())
                .collect();
            if values.len() < 2 {
                continue;
            }
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            if mean == 0.0 {
                continue;
            }
            let variance =
                values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
            let cv = variance.sqrt() / mean.abs();
            total_cv += cv;
            count += 1;
        }
        if count == 0 {
            return 100.0;
        }
        // Convert to 0-100 scale (lower CV = higher stability)
        (1.0 - (total_cv / count as f64).min(1.0)) * 100.0
    }
    /// Calculate robustness score
    fn calculate_robustness(
        &self,
        avg_is_sharpe: f64,
        avg_oos_sharpe: f64,
        param_stability: f64,
        windows: &[WalkForwardWindow],
    ) -> f64 {
        // OOS performance weight (40%)
        let oos_score = (avg_oos_sharpe.max(0.0) / 3.0).min(1.0) * 40.0;
        // Efficiency weight (30%)
        let efficiency = if avg_is_sharpe != 0.0 {
            (avg_oos_sharpe / avg_is_sharpe).min(1.0).max(0.0)
        } else {
            0.0
        };
        let efficiency_score = efficiency * 30.0;
        // Parameter stability weight (20%)
        let stability_score = param_stability * 0.2;
        // Consistency weight (10%)
        let profitable_windows = windows
            .iter()
            .filter(|w| w.out_of_sample_result.net_profit > 0.0)
            .count();
        let consistency = profitable_windows as f64 / windows.len() as f64;
        let consistency_score = consistency * 10.0;
        (oos_score + efficiency_score + stability_score + consistency_score).min(100.0)
    }
    /// Combine all OOS results
    fn combine_oos_results(&self, windows: &[WalkForwardWindow]) -> BacktestResult {
        // Combine all OOS trades
        let mut all_trades = Vec::new();
        let mut all_equity = Vec::new();
        for window in windows {
            all_trades.extend(window.out_of_sample_result.trades.clone());
            all_equity.extend(window.out_of_sample_result.equity_curve.clone());
        }
        // Recalculate stats
        let final_capital = if let Some(last) = all_equity.last() {
            last.value
        } else {
            self.initial_capital
        };
        let (max_dd, max_dd_pct) =
            crate::backtest::calculate_max_drawdown(&all_equity, self.initial_capital);
        crate::backtest::calculate_backtest_stats(
            all_trades,
            all_equity,
            self.initial_capital,
            final_capital,
            max_dd,
            max_dd_pct,
        )
    }
    fn empty_result(&self) -> WalkForwardResult {
        WalkForwardResult {
            windows: vec![],
            combined_oos_trades: BacktestResult::default(),
            avg_in_sample_sharpe: 0.0,
            avg_out_of_sample_sharpe: 0.0,
            walk_forward_efficiency: 0.0,
            robustness_score: 0.0,
            total_windows: 0,
            optimization_time_ms: 0,
            parameter_stability: 0.0,
        }
    }
}
/// Convenience function for walk-forward analysis
pub fn run_walk_forward(
    data: &[OHLCV],
    generate_signals: impl Fn(&[OHLCV], &StrategyParams) -> Vec<Signal> + Sync,
    base_params: &StrategyParams,
    config: WalkForwardConfig,
    settings: BacktestSettings,
    initial_capital: f64,
    position_size_percent: f64,
    commission_percent: f64,
) -> WalkForwardResult {
    let runner = WalkForwardRunner::new(
        config,
        settings,
        initial_capital,
        position_size_percent,
        commission_percent,
    );
    runner.run(data, generate_signals, base_params, None::<fn(f64, &str)>)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_generate_windows() {
        let config = WalkForwardConfig {
            optimization_window: 100,
            test_window: 20,
            step_size: 20,
            parameter_ranges: vec![],
            top_n: 5,
            min_trades: 10,
        };
        let runner = WalkForwardRunner::new(config, BacktestSettings::default(), 10000.0, 2.0, 0.1);
        let windows = runner.generate_windows(200);
        assert!(!windows.is_empty());
        // First window: 0-100 (opt), 100-120 (test)
        assert_eq!(windows[0], (0, 100, 100, 120));
    }
}
