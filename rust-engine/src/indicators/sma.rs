//! Simple Moving Average (SMA)
/// Calculate Simple Moving Average
///
/// # Arguments
/// * `data` - Price data
/// * `period` - SMA period
///
/// # Returns
/// Vector of SMA values (NaN for insufficient data points)
pub fn calculate_sma(data: &[f64], period: usize) -> Vec<f64> {
    if data.is_empty() || period == 0 {
        return vec![f64::NAN; data.len()];
    }
    let mut result = vec![f64::NAN; data.len()];
    if data.len() < period {
        return result;
    }
    // Calculate initial sum
    let mut sum: f64 = data[..period].iter().sum();
    let inv_period = 1.0 / period as f64;
    result[period - 1] = sum * inv_period;
    // Rolling sum for O(n) complexity
    for i in period..data.len() {
        sum += data[i] - data[i - period];
        result[i] = sum * inv_period;
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_sma_basic() {
        let data = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let sma = calculate_sma(&data, 3);
        assert!(sma[0].is_nan());
        assert!(sma[1].is_nan());
        assert!((sma[2] - 2.0).abs() < 1e-10); // (1+2+3)/3 = 2
        assert!((sma[3] - 3.0).abs() < 1e-10); // (2+3+4)/3 = 3
        assert!((sma[4] - 4.0).abs() < 1e-10); // (3+4+5)/3 = 4
    }
    #[test]
    fn test_sma_empty() {
        let data: Vec<f64> = vec![];
        let sma = calculate_sma(&data, 3);
        assert!(sma.is_empty());
    }
    #[test]
    fn test_sma_insufficient_data() {
        let data = vec![1.0, 2.0];
        let sma = calculate_sma(&data, 5);
        assert!(sma.iter().all(|v| v.is_nan()));
    }
}
