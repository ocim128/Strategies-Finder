//! Backtesting Engine Module
//!
//! High-performance backtesting for trading strategies.
mod engine;
pub use engine::calculate_backtest_stats;
pub use engine::calculate_max_drawdown;
pub use engine::run_backtest;
pub(crate) use engine::{
    build_market_series, run_backtest_with_market_series, run_backtest_with_market_series_options,
};
