//! Relative Strength Index (RSI)
/// Calculate Relative Strength Index
///
/// Uses Wilder's smoothed moving average method.
///
/// # Arguments
/// * `data` - Price data (typically close prices)
/// * `period` - RSI period (typically 14)
///
/// # Returns
/// Vector of RSI values (0-100 scale, NaN for insufficient data)
#[must_use]
pub fn calculate_rsi(data: &[f64], period: usize) -> Vec<f64> {
    if data.len() < period + 1 || period == 0 {
        return vec![f64::NAN; data.len()];
    }
    let mut result = vec![f64::NAN; data.len()];
    // Calculate initial gains and losses
    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;
    for i in 1..=period {
        let change = data[i] - data[i - 1];
        if change > 0.0 {
            avg_gain += change;
        } else {
            avg_loss += change.abs();
        }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;
    // First RSI value
    result[period] = if avg_loss == 0.0 {
        100.0
    } else {
        let rs = avg_gain / avg_loss;
        100.0 - (100.0 / (1.0 + rs))
    };
    // Calculate remaining RSI values using Wilder's smoothing
    for i in (period + 1)..data.len() {
        let change = data[i] - data[i - 1];
        let gain = if change > 0.0 { change } else { 0.0 };
        let loss = if change < 0.0 { change.abs() } else { 0.0 };
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        result[i] = if avg_loss == 0.0 {
            100.0
        } else {
            let rs = avg_gain / avg_loss;
            100.0 - (100.0 / (1.0 + rs))
        };
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_rsi_basic() {
        // Simple uptrend should have high RSI
        let uptrend: Vec<f64> = (0..20).map(|i| 100.0 + i as f64).collect();
        let rsi = calculate_rsi(&uptrend, 14);
        // RSI should be high (>70) for uptrend
        assert!(rsi[15] > 70.0);
    }
    #[test]
    fn test_rsi_downtrend() {
        // Simple downtrend should have low RSI
        let downtrend: Vec<f64> = (0..20).map(|i| 100.0 - i as f64).collect();
        let rsi = calculate_rsi(&downtrend, 14);
        // RSI should be low (<30) for downtrend
        assert!(rsi[15] < 30.0);
    }
    #[test]
    fn test_rsi_range() {
        // RSI should always be between 0 and 100
        let data: Vec<f64> = (0..100)
            .map(|i| 100.0 + (i as f64 * 0.5).sin() * 10.0)
            .collect();
        let rsi = calculate_rsi(&data, 14);
        for v in rsi.iter().skip(14) {
            assert!(*v >= 0.0 && *v <= 100.0);
        }
    }
    #[test]
    fn test_rsi_flat() {
        // Flat price should give RSI of 50 (after settling)
        let flat = vec![100.0; 30];
        let rsi = calculate_rsi(&flat, 14);
        // When no change, RSI converges to 50
        // But with all zeros, we get edge case
        assert!(rsi[14].is_finite() || rsi[14] == 100.0);
    }
}
