//! Average True Range (ATR)
/// Calculate Average True Range
///
/// Uses Wilder's smoothing method for the ATR calculation.
///
/// # Arguments
/// * `high` - High prices
/// * `low` - Low prices
/// * `close` - Close prices
/// * `period` - ATR period (typically 14)
///
/// # Returns
/// Vector of ATR values (NaN for insufficient data)
#[must_use]
pub fn calculate_atr(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let len = close.len();
    if len < period || period == 0 || high.len() != len || low.len() != len {
        return vec![f64::NAN; len];
    }
    let mut result = vec![f64::NAN; len];
    let mut initial_tr_sum = 0.0;
    for i in 0..len {
        // Calculate True Range
        let tr = if i == 0 {
            high[i] - low[i]
        } else {
            let hl = high[i] - low[i];
            let hc = (high[i] - close[i - 1]).abs();
            let lc = (low[i] - close[i - 1]).abs();
            hl.max(hc).max(lc)
        };
        if i < period - 1 {
            initial_tr_sum += tr;
        } else if i == period - 1 {
            initial_tr_sum += tr;
            result[i] = initial_tr_sum / period as f64;
        } else {
            // Wilder's smoothing: ATR = ((prev_ATR * (period - 1)) + TR) / period
            let prev_atr = result[i - 1];
            result[i] = (prev_atr * (period as f64 - 1.0) + tr) / period as f64;
        }
    }
    result
}
/// Calculate True Range for a single bar
#[inline]
#[must_use]
pub fn true_range(high: f64, low: f64, prev_close: Option<f64>) -> f64 {
    let hl = high - low;
    match prev_close {
        Some(pc) => {
            let hc = (high - pc).abs();
            let lc = (low - pc).abs();
            hl.max(hc).max(lc)
        }
        None => hl,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_atr_basic() {
        let high = vec![10.0, 11.0, 12.0, 11.5, 12.5, 13.0, 12.0, 13.0, 14.0, 13.5];
        let low = vec![9.0, 9.5, 10.5, 10.0, 11.0, 11.5, 11.0, 11.5, 12.5, 12.0];
        let close = vec![9.5, 10.5, 11.5, 11.0, 12.0, 12.5, 11.5, 12.5, 13.5, 12.5];
        let atr = calculate_atr(&high, &low, &close, 5);
        // First 4 should be NaN
        assert!(atr[0].is_nan());
        assert!(atr[3].is_nan());
        // 5th value should be valid
        assert!(atr[4].is_finite());
        assert!(atr[4] > 0.0);
    }
    #[test]
    fn test_true_range() {
        // Normal case: high - low is largest
        assert!((true_range(110.0, 100.0, Some(105.0)) - 10.0).abs() < 1e-10);
        // Gap up: high - prev_close is largest
        assert!((true_range(120.0, 115.0, Some(100.0)) - 20.0).abs() < 1e-10);
        // Gap down: prev_close - low is largest
        assert!((true_range(95.0, 90.0, Some(110.0)) - 20.0).abs() < 1e-10);
        // No previous close
        assert!((true_range(110.0, 100.0, None) - 10.0).abs() < 1e-10);
    }
    #[test]
    fn test_atr_smoothing() {
        // ATR should smooth out volatility
        let mut high = vec![];
        let mut low = vec![];
        let mut close = vec![];
        for i in 0..50 {
            let base = 100.0 + (i as f64 * 0.1);
            high.push(base + 1.0);
            low.push(base - 1.0);
            close.push(base);
        }
        let atr = calculate_atr(&high, &low, &close, 14);
        // ATR should be around 2.0 (since high-low is always 2)
        assert!((atr[20] - 2.0).abs() < 0.5);
    }
}
