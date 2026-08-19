//! Technical Indicators Module
//!
//! High-performance implementations of common technical indicators.
//! All indicators are optimized for processing millions of data points.
mod adx;
mod atr;
mod bollinger;
mod ema;
mod macd;
mod rsi;
mod sma;
mod stochastic;
mod supertrend;
use crate::types::OHLCV;
pub use adx::{calculate_adx, calculate_adx_with_di};
pub use atr::{calculate_atr, true_range};
pub use bollinger::{
    calculate_bandwidth, calculate_bollinger_bands, calculate_percent_b, BollingerBands,
};
pub use ema::calculate_ema;
pub use macd::{calculate_macd, MACDResult};
pub use rsi::calculate_rsi;
pub use sma::calculate_sma;
use std::collections::HashMap;
pub use stochastic::{calculate_stochastic, StochasticResult};
pub use supertrend::{calculate_supertrend, supertrend_crossover, SupertrendResult};
/// Pre-computed indicators for efficient backtest parameter sweeps
///
/// Compute all needed indicators once, then reuse across thousands
/// of parameter combinations in walk-forward/finder optimization.
///
/// # Note
/// These types are part of the public library API but may not be used
/// internally by the server binary.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PrecomputedIndicators {
    /// ATR values by period: period -> values
    pub atr: HashMap<u32, Vec<f64>>,
    /// EMA values by period: period -> values
    pub ema: HashMap<u32, Vec<f64>>,
    /// RSI values by period: period -> values
    pub rsi: HashMap<u32, Vec<f64>>,
    /// ADX values by period: period -> values
    pub adx: HashMap<u32, Vec<f64>>,
    /// SMA values by period: period -> values
    pub sma: HashMap<u32, Vec<f64>>,
    /// Volume SMA by period
    pub volume_sma: HashMap<u32, Vec<f64>>,
}
#[allow(dead_code)]
impl PrecomputedIndicators {
    /// Create new empty indicator cache
    pub fn new() -> Self {
        Self {
            atr: HashMap::new(),
            ema: HashMap::new(),
            rsi: HashMap::new(),
            adx: HashMap::new(),
            sma: HashMap::new(),
            volume_sma: HashMap::new(),
        }
    }
    /// Compute all indicators needed for the given periods
    ///
    /// Uses Rayon for parallel computation when beneficial
    pub fn compute_all(data: &[OHLCV], periods: &IndicatorPeriods) -> Self {
        let closes: Vec<f64> = data.iter().map(|d| d.close).collect();
        let highs: Vec<f64> = data.iter().map(|d| d.high).collect();
        let lows: Vec<f64> = data.iter().map(|d| d.low).collect();
        let volumes: Vec<f64> = data.iter().map(|d| d.volume).collect();
        let mut indicators = Self::new();
        // Compute ATR for each period
        for &period in &periods.atr {
            let atr = calculate_atr(&highs, &lows, &closes, period as usize);
            indicators.atr.insert(period, atr);
        }
        // Compute EMA for each period
        for &period in &periods.ema {
            let ema = calculate_ema(&closes, period as usize);
            indicators.ema.insert(period, ema);
        }
        // Compute RSI for each period
        for &period in &periods.rsi {
            let rsi = calculate_rsi(&closes, period as usize);
            indicators.rsi.insert(period, rsi);
        }
        // Compute ADX for each period
        for &period in &periods.adx {
            let adx = calculate_adx(&highs, &lows, &closes, period as usize);
            indicators.adx.insert(period, adx);
        }
        // Compute SMA for each period
        for &period in &periods.sma {
            let sma = calculate_sma(&closes, period as usize);
            indicators.sma.insert(period, sma);
        }
        // Compute Volume SMA
        for &period in &periods.volume_sma {
            let vol_sma = calculate_sma(&volumes, period as usize);
            indicators.volume_sma.insert(period, vol_sma);
        }
        indicators
    }
    /// Get ATR value at index for given period
    #[inline]
    pub fn get_atr(&self, period: u32, index: usize) -> Option<f64> {
        self.atr.get(&period).and_then(|v| v.get(index).copied())
    }
    /// Get EMA value at index for given period
    #[inline]
    pub fn get_ema(&self, period: u32, index: usize) -> Option<f64> {
        self.ema.get(&period).and_then(|v| v.get(index).copied())
    }
    /// Get RSI value at index for given period
    #[inline]
    pub fn get_rsi(&self, period: u32, index: usize) -> Option<f64> {
        self.rsi.get(&period).and_then(|v| v.get(index).copied())
    }
    /// Get ADX value at index for given period
    #[inline]
    pub fn get_adx(&self, period: u32, index: usize) -> Option<f64> {
        self.adx.get(&period).and_then(|v| v.get(index).copied())
    }
}
impl Default for PrecomputedIndicators {
    fn default() -> Self {
        Self::new()
    }
}
/// Periods to pre-compute for each indicator type
///
/// # Note
/// This type is part of the public library API but may not be used
/// internally by the server binary.
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct IndicatorPeriods {
    pub atr: Vec<u32>,
    pub ema: Vec<u32>,
    pub rsi: Vec<u32>,
    pub adx: Vec<u32>,
    pub sma: Vec<u32>,
    pub volume_sma: Vec<u32>,
}
impl IndicatorPeriods {
    /// Create periods from backtest settings
    pub fn from_settings(settings: &crate::types::BacktestSettings) -> Self {
        Self {
            atr: vec![settings.atr_period],
            ema: vec![settings.trend_ema_period],
            rsi: vec![settings.rsi_period],
            adx: vec![settings.adx_period],
            sma: vec![],
            volume_sma: vec![settings.volume_sma_period],
        }
    }
}
