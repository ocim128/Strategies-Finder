//! Rust backtest kernel for the optional local trading-engine server.
//!
//! Strategy signal generation remains in TypeScript. This crate accepts OHLCV
//! data and signals, then performs the CPU-heavy simulation and metric work.
//!
//! # Quick Start
//!
//! ```rust,ignore
//! use trading_engine::{OHLCV, Signal, BacktestSettings, run_backtest};
//!
//! let result = run_backtest(
//!     &data,
//!     &signals,
//!     10000.0,
//!     2.0,
//!     0.1,
//!     &BacktestSettings::default(),
//!     None,
//!     false,
//! );
//! println!("Net Profit: ${:.2}", result.net_profit);
//! ```
pub mod api;
pub mod backtest;
pub mod indicators;
pub mod types;

pub use backtest::run_backtest;
pub use types::{
    BacktestRequest, BacktestResult, BacktestSettings, Signal, SignalType, Trade, TradeType, OHLCV,
};
