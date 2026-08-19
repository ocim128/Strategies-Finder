//! Trading Engine - High-Performance Backtesting for 5M+ Candle Bars
//!
//! This crate provides a Rust-based trading engine optimized for:
//! - Ultra-fast backtesting (100-500x faster than TypeScript)
//! - Parallel walk-forward optimization using Rayon
//! - Memory-efficient processing of millions of candle bars
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────┐
//! │                    TypeScript Frontend                   │
//! └─────────────────────────┬───────────────────────────────┘
//!                           │ HTTP/WebSocket
//! ┌─────────────────────────▼───────────────────────────────┐
//! │                      Axum API Server                     │
//! ├─────────────────────────────────────────────────────────┤
//! │  Indicators  │  Backtest Engine  │  Walk-Forward/Finder │
//! ├─────────────────────────────────────────────────────────┤
//! │                    Rayon Thread Pool                     │
//! └─────────────────────────────────────────────────────────┘
//! ```
//!
//! # Quick Start
//!
//! ```rust,ignore
//! use trading_engine::{OHLCV, Signal, BacktestSettings, run_backtest};
//!
//! let data: Vec<OHLCV> = load_data();
//! let signals: Vec<Signal> = generate_signals(&data);
//! let result = run_backtest(&data, &signals, 10000.0, 2.0, 0.1, &BacktestSettings::default());
//! println!("Net Profit: ${:.2}", result.net_profit);
//! ```
pub mod api;
pub mod backtest;
pub mod indicators;
pub mod optimizer;
pub mod types;
// Re-export commonly used types
pub use types::{
    BacktestRequest, BacktestResult, BacktestSettings, FinderOptions, FinderRequest, FinderResult,
    ProgressUpdate, Signal, SignalType, StrategyParams, Trade, TradeType, WalkForwardConfig,
    WalkForwardRequest, WalkForwardResult, OHLCV,
};
// Re-export main functions
pub use backtest::run_backtest;
pub use indicators::PrecomputedIndicators;
