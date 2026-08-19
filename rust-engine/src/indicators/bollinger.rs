//! Bollinger Bands
use super::sma::calculate_sma;
/// Bollinger Bands result
///
/// Part of the public library API for external consumers.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct BollingerBands {
    /// Upper band (SMA + stddev * multiplier)
    pub upper: Vec<f64>,
    /// Middle band (SMA)
    pub middle: Vec<f64>,
    /// Lower band (SMA - stddev * multiplier)
    pub lower: Vec<f64>,
}
/// Calculate Bollinger Bands
///
/// # Arguments
/// * `data` - Price data (typically close prices)
/// * `period` - SMA period (typically 20)
/// * `std_dev` - Standard deviation multiplier (typically 2.0)
///
/// # Returns
/// BollingerBands containing upper, middle, and lower bands
pub fn calculate_bollinger_bands(data: &[f64], period: usize, std_dev: f64) -> BollingerBands {
    let len = data.len();
    if len < period || period == 0 {
        return BollingerBands {
            upper: vec![f64::NAN; len],
            middle: vec![f64::NAN; len],
            lower: vec![f64::NAN; len],
        };
    }
    let middle = calculate_sma(data, period);
    let mut upper = vec![f64::NAN; len];
    let mut lower = vec![f64::NAN; len];
    // Use rolling sum and sum of squares for O(n) std dev calculation
    let mut sum: f64 = 0.0;
    let mut sum_sq: f64 = 0.0;
    let period_f = period as f64;
    for i in 0..len {
        let val = data[i];
        sum += val;
        sum_sq += val * val;
        if i >= period {
            let old_val = data[i - period];
            sum -= old_val;
            sum_sq -= old_val * old_val;
        }
        if i >= period - 1 {
            let avg = sum / period_f;
            // Variance = (SumSq - (Sum^2 / N)) / N
            let variance = (sum_sq - (sum * sum) / period_f) / period_f;
            let std = variance.max(0.0).sqrt();
            upper[i] = avg + std_dev * std;
            lower[i] = avg - std_dev * std;
        }
    }
    BollingerBands {
        upper,
        middle,
        lower,
    }
}
/// Calculate Bollinger Band %B
///
/// %B = (Price - Lower Band) / (Upper Band - Lower Band)
/// * %B > 1: Price above upper band
/// * %B < 0: Price below lower band
/// * %B = 0.5: Price at middle band
#[inline]
pub fn calculate_percent_b(price: f64, upper: f64, lower: f64) -> f64 {
    let range = upper - lower;
    if range == 0.0 {
        return 0.5;
    }
    (price - lower) / range
}
/// Calculate Bandwidth
///
/// Bandwidth = (Upper Band - Lower Band) / Middle Band
/// Measures volatility - narrowing bands often precede breakouts
#[inline]
pub fn calculate_bandwidth(upper: f64, middle: f64, lower: f64) -> f64 {
    if middle == 0.0 {
        return 0.0;
    }
    (upper - lower) / middle
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_bollinger_basic() {
        let data = vec![
            22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39,
            22.38, 22.61, 23.36, 24.05, 23.75, 23.83, 23.95, 23.63,
        ];
        let bb = calculate_bollinger_bands(&data, 5, 2.0);
        // First 4 should be NaN
        assert!(bb.upper[0].is_nan());
        assert!(bb.middle[3].is_nan());
        // 5th value should be valid
        assert!(!bb.upper[4].is_nan());
        assert!(bb.upper[4] > bb.middle[4]);
        assert!(bb.lower[4] < bb.middle[4]);
    }
    #[test]
    fn test_bollinger_symmetry() {
        let data = vec![100.0; 20];
        let bb = calculate_bollinger_bands(&data, 5, 2.0);
        // For constant data, bands should converge to the constant
        for i in 5..20 {
            assert!((bb.middle[i] - 100.0).abs() < 0.01);
            // Upper and lower should be symmetric around middle
            let upper_dist = bb.upper[i] - bb.middle[i];
            let lower_dist = bb.middle[i] - bb.lower[i];
            assert!((upper_dist - lower_dist).abs() < 0.01);
        }
    }
    #[test]
    fn test_percent_b() {
        // Price at middle
        assert!((calculate_percent_b(100.0, 110.0, 90.0) - 0.5).abs() < 0.01);
        // Price at upper
        assert!((calculate_percent_b(110.0, 110.0, 90.0) - 1.0).abs() < 0.01);
        // Price at lower
        assert!((calculate_percent_b(90.0, 110.0, 90.0) - 0.0).abs() < 0.01);
        // Price above upper
        assert!(calculate_percent_b(120.0, 110.0, 90.0) > 1.0);
    }
    #[test]
    fn test_bandwidth() {
        let bw = calculate_bandwidth(110.0, 100.0, 90.0);
        assert!((bw - 0.2).abs() < 0.01); // (110-90)/100 = 0.2
    }
}
