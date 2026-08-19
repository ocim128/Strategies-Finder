//! Stochastic Oscillator
use std::collections::VecDeque;
/// Stochastic oscillator result
///
/// Part of the public library API for external consumers.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct StochasticResult {
    /// %K - Fast stochastic
    pub k: Vec<f64>,
    /// %D - Slow stochastic (SMA of %K)
    pub d: Vec<f64>,
}
/// Calculate Stochastic Oscillator
///
/// Uses monotonic deques for O(n) performance.
///
/// # Arguments
/// * `high` - High prices
/// * `low` - Low prices
/// * `close` - Close prices
/// * `k_period` - %K period (typically 14)
/// * `d_period` - %D period (typically 3)
///
/// # Returns
/// StochasticResult containing %K and %D values
pub fn calculate_stochastic(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    k_period: usize,
    d_period: usize,
) -> StochasticResult {
    let len = close.len();
    if len < k_period || k_period == 0 || d_period == 0 || high.len() != len || low.len() != len {
        return StochasticResult {
            k: vec![f64::NAN; len],
            d: vec![f64::NAN; len],
        };
    }
    let mut k = vec![f64::NAN; len];
    let mut d = vec![f64::NAN; len];
    // Monotonic deques for O(1) sliding window min/max
    let mut max_deque: VecDeque<usize> = VecDeque::new();
    let mut min_deque: VecDeque<usize> = VecDeque::new();
    for i in 0..len {
        // Maintain max deque (for highest high)
        while !max_deque.is_empty() && high[*max_deque.back().unwrap()] <= high[i] {
            max_deque.pop_back();
        }
        max_deque.push_back(i);
        // Remove elements outside window
        while !max_deque.is_empty() && *max_deque.front().unwrap() + k_period <= i {
            max_deque.pop_front();
        }
        // Maintain min deque (for lowest low)
        while !min_deque.is_empty() && low[*min_deque.back().unwrap()] >= low[i] {
            min_deque.pop_back();
        }
        min_deque.push_back(i);
        while !min_deque.is_empty() && *min_deque.front().unwrap() + k_period <= i {
            min_deque.pop_front();
        }
        if i >= k_period - 1 {
            let highest_high = high[*max_deque.front().unwrap()];
            let lowest_low = low[*min_deque.front().unwrap()];
            let range = highest_high - lowest_low;
            k[i] = if range == 0.0 {
                50.0 // Neutral when no range
            } else {
                ((close[i] - lowest_low) / range) * 100.0
            };
        }
    }
    // Calculate %D (SMA of %K)
    let mut d_sum = 0.0;
    let mut d_count = 0usize;
    for i in 0..len {
        if !k[i].is_nan() {
            d_sum += k[i];
            d_count += 1;
            if d_count > d_period {
                // Subtract the value that's now outside the window
                let old_idx = i - d_period;
                if !k[old_idx].is_nan() {
                    d_sum -= k[old_idx];
                    d_count -= 1;
                }
            }
            if d_count >= d_period {
                d[i] = d_sum / d_period as f64;
            }
        }
    }
    StochasticResult { k, d }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_stochastic_basic() {
        let high = vec![
            127.0, 127.0, 126.0, 127.0, 128.0, 128.0, 127.0, 126.0, 126.0, 127.0, 127.0, 126.0,
            127.0, 127.0, 128.0,
        ];
        let low = vec![
            125.0, 126.0, 124.0, 126.0, 126.0, 126.0, 125.0, 124.0, 126.0, 126.0, 125.0, 125.0,
            125.0, 126.0, 126.0,
        ];
        let close = vec![
            126.0, 127.0, 125.0, 127.0, 127.0, 127.0, 126.0, 125.0, 126.0, 127.0, 126.0, 126.0,
            126.0, 127.0, 127.0,
        ];
        let result = calculate_stochastic(&high, &low, &close, 5, 3);
        // First 4 values should be NaN
        assert!(result.k[0].is_nan());
        assert!(result.k[3].is_nan());
        // Values should be between 0 and 100
        for v in result.k.iter().skip(4) {
            if v.is_finite() {
                assert!(*v >= 0.0 && *v <= 100.0);
            }
        }
    }
    #[test]
    fn test_stochastic_extremes() {
        // Price at highest high
        let high = vec![100.0, 101.0, 102.0, 103.0, 104.0];
        let low = vec![98.0, 99.0, 100.0, 101.0, 102.0];
        let close = vec![99.0, 100.0, 101.0, 102.0, 104.0]; // Close at high
        let result = calculate_stochastic(&high, &low, &close, 5, 3);
        // When close is at highest high, %K should be 100
        assert!((result.k[4] - 100.0).abs() < 0.01);
    }
    #[test]
    fn test_stochastic_oversold() {
        // Strong downtrend - should be oversold
        let high: Vec<f64> = (0..20).map(|i| 100.0 - i as f64 + 1.0).collect();
        let low: Vec<f64> = (0..20).map(|i| 100.0 - i as f64 - 1.0).collect();
        let close: Vec<f64> = (0..20).map(|i| 100.0 - i as f64 - 0.5).collect(); // Close near low
        let result = calculate_stochastic(&high, &low, &close, 14, 3);
        // Should be oversold (< 20) in downtrend
        assert!(result.k[19] < 30.0);
    }
}
