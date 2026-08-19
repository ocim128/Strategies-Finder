//! MACD (Moving Average Convergence Divergence)
use super::ema::calculate_ema;
/// MACD calculation result
///
/// Part of the public library API for external consumers.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MACDResult {
    /// MACD line (fast EMA - slow EMA)
    pub macd: Vec<f64>,
    /// Signal line (EMA of MACD)
    pub signal: Vec<f64>,
    /// Histogram (MACD - Signal)
    pub histogram: Vec<f64>,
}
/// Calculate MACD indicator
///
/// # Arguments
/// * `data` - Price data (typically close prices)
/// * `fast_period` - Fast EMA period (typically 12)
/// * `slow_period` - Slow EMA period (typically 26)
/// * `signal_period` - Signal line period (typically 9)
///
/// # Returns
/// MACDResult containing MACD line, signal line, and histogram
pub fn calculate_macd(
    data: &[f64],
    fast_period: usize,
    slow_period: usize,
    signal_period: usize,
) -> MACDResult {
    let len = data.len();
    if len < slow_period || fast_period == 0 || slow_period == 0 || signal_period == 0 {
        return MACDResult {
            macd: vec![f64::NAN; len],
            signal: vec![f64::NAN; len],
            histogram: vec![f64::NAN; len],
        };
    }
    let fast_ema = calculate_ema(data, fast_period);
    let slow_ema = calculate_ema(data, slow_period);
    // Calculate MACD line
    let mut macd = vec![f64::NAN; len];
    for i in 0..len {
        if !fast_ema[i].is_nan() && !slow_ema[i].is_nan() {
            macd[i] = fast_ema[i] - slow_ema[i];
        }
    }
    // Calculate signal line (EMA of MACD)
    let mut signal = vec![f64::NAN; len];
    let mut histogram = vec![f64::NAN; len];
    let multiplier = 2.0 / (signal_period as f64 + 1.0);
    let mut valid_macd_count = 0;
    let mut init_sum = 0.0;
    let mut prev_signal: Option<f64> = None;
    for i in 0..len {
        if macd[i].is_nan() {
            continue;
        }
        match prev_signal {
            None => {
                init_sum += macd[i];
                valid_macd_count += 1;
                if valid_macd_count == signal_period {
                    let sig = init_sum / signal_period as f64;
                    signal[i] = sig;
                    histogram[i] = macd[i] - sig;
                    prev_signal = Some(sig);
                }
            }
            Some(prev) => {
                let current_signal = (macd[i] - prev) * multiplier + prev;
                signal[i] = current_signal;
                histogram[i] = macd[i] - current_signal;
                prev_signal = Some(current_signal);
            }
        }
    }
    MACDResult {
        macd,
        signal,
        histogram,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_macd_basic() {
        let data: Vec<f64> = (0..50)
            .map(|i| 100.0 + (i as f64 * 0.5).sin() * 5.0)
            .collect();
        let result = calculate_macd(&data, 12, 26, 9);
        // MACD should have values after slow period (index 25 = period 26 - 1)
        assert!(result.macd[24].is_nan()); // Before slow EMA is ready
        assert!(!result.macd[26].is_nan()); // After slow EMA is ready
    }
    #[test]
    fn test_macd_histogram() {
        let data: Vec<f64> = (0..50).map(|i| 100.0 + i as f64).collect();
        let result = calculate_macd(&data, 12, 26, 9);
        // Histogram = MACD - Signal
        for i in 0..50 {
            if !result.macd[i].is_nan() && !result.signal[i].is_nan() {
                let expected = result.macd[i] - result.signal[i];
                assert!((result.histogram[i] - expected).abs() < 1e-10);
            }
        }
    }
    #[test]
    fn test_macd_uptrend() {
        // Strong uptrend: MACD should be positive
        let data: Vec<f64> = (0..50).map(|i| 100.0 + i as f64 * 2.0).collect();
        let result = calculate_macd(&data, 12, 26, 9);
        // MACD should be positive in uptrend (fast EMA > slow EMA)
        assert!(result.macd[40] > 0.0);
    }
}
