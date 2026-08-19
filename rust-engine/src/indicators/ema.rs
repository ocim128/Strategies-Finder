//! Exponential Moving Average (EMA)
/// Calculate Exponential Moving Average
///
/// Uses Wilder's smoothing method.
///
/// # Arguments
/// * `data` - Price data
/// * `period` - EMA period
///
/// # Returns
/// Vector of EMA values (NaN for insufficient data points)
#[must_use]
pub fn calculate_ema(data: &[f64], period: usize) -> Vec<f64> {
    if data.is_empty() || period == 0 {
        return vec![f64::NAN; data.len()];
    }
    let mut result = vec![f64::NAN; data.len()];
    if data.len() < period {
        return result;
    }
    let multiplier = 2.0 / (period as f64 + 1.0);
    // Calculate initial SMA as seed
    let initial_sma: f64 = data[..period].iter().sum::<f64>() / period as f64;
    result[period - 1] = initial_sma;
    // Calculate EMA
    let mut prev_ema = initial_sma;
    for i in period..data.len() {
        let current_ema = (data[i] - prev_ema) * multiplier + prev_ema;
        result[i] = current_ema;
        prev_ema = current_ema;
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_ema_basic() {
        let data = vec![
            22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29,
        ];
        let ema = calculate_ema(&data, 5);
        // First 4 values should be NaN
        assert!(ema[0].is_nan());
        assert!(ema[3].is_nan());
        // 5th value should be SMA of first 5
        let expected_sma = (22.27 + 22.19 + 22.08 + 22.17 + 22.18) / 5.0;
        assert!((ema[4] - expected_sma).abs() < 0.01);
    }
    #[test]
    fn test_ema_empty() {
        let data: Vec<f64> = vec![];
        let ema = calculate_ema(&data, 3);
        assert!(ema.is_empty());
    }
    #[test]
    fn test_ema_convergence() {
        // EMA should converge towards constant value
        let data = vec![100.0; 50];
        let ema = calculate_ema(&data, 10);
        // Last values should all be ~100
        for &v in &ema[10..] {
            assert!((v - 100.0).abs() < 0.01);
        }
    }
}
