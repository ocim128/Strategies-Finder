//! Supertrend Indicator
use super::atr::calculate_atr;
/// Supertrend result
///
/// Part of the public library API for external consumers.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct SupertrendResult {
    /// Supertrend line values
    pub supertrend: Vec<f64>,
    /// Trend direction: 1 = bullish (below price), -1 = bearish (above price)
    pub direction: Vec<i8>,
}
/// Calculate Supertrend Indicator
///
/// # Arguments
/// * `high` - High prices
/// * `low` - Low prices
/// * `close` - Close prices
/// * `period` - ATR period (typically 10)
/// * `factor` - ATR multiplier (typically 3.0)
///
/// # Returns
/// SupertrendResult containing supertrend line and direction
pub fn calculate_supertrend(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
    factor: f64,
) -> SupertrendResult {
    let len = close.len();
    if len < period || period == 0 || high.len() != len || low.len() != len {
        return SupertrendResult {
            supertrend: vec![f64::NAN; len],
            direction: vec![0; len],
        };
    }
    let atr = calculate_atr(high, low, close, period);
    let mut supertrend = vec![f64::NAN; len];
    let mut direction = vec![0i8; len];
    let mut prev_final_upper = 0.0;
    let mut prev_final_lower = 0.0;
    let mut prev_trend: i8 = 1;
    for i in 0..len {
        if atr[i].is_nan() {
            continue;
        }
        let hl2 = (high[i] + low[i]) / 2.0;
        let basic_upper = hl2 + factor * atr[i];
        let basic_lower = hl2 - factor * atr[i];
        // First valid bar initialization
        if supertrend[..i].iter().all(|v| v.is_nan()) {
            supertrend[i] = basic_lower;
            direction[i] = 1;
            prev_final_upper = basic_upper;
            prev_final_lower = basic_lower;
            prev_trend = 1;
            continue;
        }
        let prev_close = close[i - 1];
        // Calculate Final Upper Band
        let final_upper = if basic_upper < prev_final_upper || prev_close > prev_final_upper {
            basic_upper
        } else {
            prev_final_upper
        };
        // Calculate Final Lower Band
        let final_lower = if basic_lower > prev_final_lower || prev_close < prev_final_lower {
            basic_lower
        } else {
            prev_final_lower
        };
        // Determine Trend
        let current_trend = if prev_trend == 1 {
            if close[i] < final_lower {
                -1
            } else {
                1
            }
        } else if close[i] > final_upper {
            1
        } else {
            -1
        };
        direction[i] = current_trend;
        supertrend[i] = if current_trend == 1 {
            final_lower
        } else {
            final_upper
        };
        prev_final_upper = final_upper;
        prev_final_lower = final_lower;
        prev_trend = current_trend;
    }
    SupertrendResult {
        supertrend,
        direction,
    }
}
/// Check for Supertrend crossover (trend change)
///
/// Returns:
/// * Some(1) if bullish crossover (trend changed from -1 to 1)
/// * Some(-1) if bearish crossover (trend changed from 1 to -1)
/// * None if no crossover
#[inline]
pub fn supertrend_crossover(current_dir: i8, prev_dir: i8) -> Option<i8> {
    if current_dir != prev_dir && prev_dir != 0 {
        Some(current_dir)
    } else {
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_supertrend_basic() {
        let mut high = vec![];
        let mut low = vec![];
        let mut close = vec![];
        // Create trending data
        for i in 0..30 {
            let base = 100.0 + i as f64;
            high.push(base + 1.0);
            low.push(base - 0.5);
            close.push(base + 0.3);
        }
        let result = calculate_supertrend(&high, &low, &close, 10, 3.0);
        // Should have valid supertrend after ATR warmup
        assert!(result.supertrend[15].is_finite());
        // In uptrend, direction should be bullish (1)
        assert_eq!(result.direction[25], 1);
        // In uptrend, supertrend should be below price
        assert!(result.supertrend[25] < close[25]);
    }
    #[test]
    fn test_supertrend_direction() {
        // Strong downtrend
        let high: Vec<f64> = (0..30).map(|i| 100.0 - i as f64 + 0.5).collect();
        let low: Vec<f64> = (0..30).map(|i| 100.0 - i as f64 - 0.5).collect();
        let close: Vec<f64> = (0..30).map(|i| 100.0 - i as f64).collect();
        let result = calculate_supertrend(&high, &low, &close, 10, 3.0);
        // In downtrend, direction should be bearish (-1)
        assert_eq!(result.direction[25], -1);
        // In downtrend, supertrend should be above price
        assert!(result.supertrend[25] > close[25]);
    }
    #[test]
    fn test_crossover() {
        assert_eq!(supertrend_crossover(1, -1), Some(1)); // Bullish crossover
        assert_eq!(supertrend_crossover(-1, 1), Some(-1)); // Bearish crossover
        assert_eq!(supertrend_crossover(1, 1), None); // No crossover
        assert_eq!(supertrend_crossover(-1, -1), None); // No crossover
        assert_eq!(supertrend_crossover(1, 0), None); // Initial state
    }
}
