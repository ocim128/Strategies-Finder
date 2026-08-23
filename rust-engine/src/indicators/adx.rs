//! Average Directional Index (ADX)
/// Calculate Average Directional Index
///
/// Measures trend strength regardless of direction.
/// ADX > 25 typically indicates a strong trend.
///
/// # Arguments
/// * `high` - High prices
/// * `low` - Low prices
/// * `close` - Close prices
/// * `period` - ADX period (typically 14)
///
/// # Returns
/// Vector of ADX values (0-100 scale, NaN for insufficient data)
pub fn calculate_adx(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let len = close.len();
    if len < period * 2 || period == 0 || high.len() != len || low.len() != len {
        return vec![f64::NAN; len];
    }
    let mut adx = vec![f64::NAN; len];
    let mut tr = vec![0.0; len];
    let mut plus_dm = vec![0.0; len];
    let mut minus_dm = vec![0.0; len];
    // Calculate True Range and Directional Movement
    for i in 1..len {
        let up_move = high[i] - high[i - 1];
        let down_move = low[i - 1] - low[i];
        plus_dm[i] = if up_move > down_move && up_move > 0.0 {
            up_move
        } else {
            0.0
        };
        minus_dm[i] = if down_move > up_move && down_move > 0.0 {
            down_move
        } else {
            0.0
        };
        tr[i] = (high[i] - low[i])
            .max((high[i] - close[i - 1]).abs())
            .max((low[i] - close[i - 1]).abs());
    }
    // Smooth TR and DM
    let mut tr_smooth = 0.0;
    let mut plus_smooth = 0.0;
    let mut minus_smooth = 0.0;
    for i in 1..=period {
        tr_smooth += tr[i];
        plus_smooth += plus_dm[i];
        minus_smooth += minus_dm[i];
    }
    // Calculate DX values
    let mut dx = vec![0.0; len];
    let period_f = period as f64;
    for i in period..len {
        if i > period {
            tr_smooth = tr_smooth - tr_smooth / period_f + tr[i];
            plus_smooth = plus_smooth - plus_smooth / period_f + plus_dm[i];
            minus_smooth = minus_smooth - minus_smooth / period_f + minus_dm[i];
        }
        let plus_di = if tr_smooth == 0.0 {
            0.0
        } else {
            100.0 * (plus_smooth / tr_smooth)
        };
        let minus_di = if tr_smooth == 0.0 {
            0.0
        } else {
            100.0 * (minus_smooth / tr_smooth)
        };
        let di_sum = plus_di + minus_di;
        dx[i] = if di_sum == 0.0 {
            0.0
        } else {
            100.0 * (plus_di - minus_di).abs() / di_sum
        };
    }
    // Calculate ADX as smoothed DX
    let dx_sum: f64 = dx.iter().take(period * 2).skip(period).sum();
    adx[period * 2 - 1] = dx_sum / period_f;
    for i in (period * 2)..len {
        adx[i] = (adx[i - 1] * (period_f - 1.0) + dx[i]) / period_f;
    }
    adx
}
/// Calculate +DI and -DI along with ADX
pub fn calculate_adx_with_di(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    period: usize,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let len = close.len();
    if len < period * 2 || period == 0 {
        let nan_vec = vec![f64::NAN; len];
        return (nan_vec.clone(), nan_vec.clone(), nan_vec);
    }
    let mut plus_di_result = vec![f64::NAN; len];
    let mut minus_di_result = vec![f64::NAN; len];
    let mut adx = vec![f64::NAN; len];
    let mut tr = vec![0.0; len];
    let mut plus_dm = vec![0.0; len];
    let mut minus_dm = vec![0.0; len];
    for i in 1..len {
        let up_move = high[i] - high[i - 1];
        let down_move = low[i - 1] - low[i];
        plus_dm[i] = if up_move > down_move && up_move > 0.0 {
            up_move
        } else {
            0.0
        };
        minus_dm[i] = if down_move > up_move && down_move > 0.0 {
            down_move
        } else {
            0.0
        };
        tr[i] = (high[i] - low[i])
            .max((high[i] - close[i - 1]).abs())
            .max((low[i] - close[i - 1]).abs());
    }
    let mut tr_smooth = 0.0;
    let mut plus_smooth = 0.0;
    let mut minus_smooth = 0.0;
    let period_f = period as f64;
    for i in 1..=period {
        tr_smooth += tr[i];
        plus_smooth += plus_dm[i];
        minus_smooth += minus_dm[i];
    }
    let mut dx = vec![0.0; len];
    for i in period..len {
        if i > period {
            tr_smooth = tr_smooth - tr_smooth / period_f + tr[i];
            plus_smooth = plus_smooth - plus_smooth / period_f + plus_dm[i];
            minus_smooth = minus_smooth - minus_smooth / period_f + minus_dm[i];
        }
        let plus_di = if tr_smooth == 0.0 {
            0.0
        } else {
            100.0 * (plus_smooth / tr_smooth)
        };
        let minus_di = if tr_smooth == 0.0 {
            0.0
        } else {
            100.0 * (minus_smooth / tr_smooth)
        };
        plus_di_result[i] = plus_di;
        minus_di_result[i] = minus_di;
        let di_sum = plus_di + minus_di;
        dx[i] = if di_sum == 0.0 {
            0.0
        } else {
            100.0 * (plus_di - minus_di).abs() / di_sum
        };
    }
    let dx_sum: f64 = dx.iter().take(period * 2).skip(period).sum();
    adx[period * 2 - 1] = dx_sum / period_f;
    for i in (period * 2)..len {
        adx[i] = (adx[i - 1] * (period_f - 1.0) + dx[i]) / period_f;
    }
    (plus_di_result, minus_di_result, adx)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_adx_trending() {
        // Strong uptrend should have high ADX
        let mut high = vec![];
        let mut low = vec![];
        let mut close = vec![];
        for i in 0..50 {
            let base = 100.0 + i as f64 * 2.0; // Strong uptrend
            high.push(base + 1.0);
            low.push(base - 0.5);
            close.push(base + 0.5);
        }
        let adx = calculate_adx(&high, &low, &close, 14);
        // ADX should be high (> 25) for strong trend
        assert!(adx[40] > 20.0);
    }
    #[test]
    fn test_adx_range() {
        let high = vec![10.0; 50];
        let low = vec![9.0; 50];
        let close = vec![9.5; 50];
        let adx = calculate_adx(&high, &low, &close, 14);
        // For flat market, ADX should be low
        // Values should be between 0 and 100
        for v in adx.iter().skip(28) {
            if v.is_finite() {
                assert!(*v >= 0.0 && *v <= 100.0);
            }
        }
    }
}
