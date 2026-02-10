import { OHLCVData } from '../../types/index';

export const TREND_EFFICIENCY_LOOKBACK = 10;
export const ATR_REGIME_LOOKBACK = 20;
export const VOLUME_TREND_SHORT = 5;
export const VOLUME_TREND_LONG = 20;
export const VOLUME_BURST_LOOKBACK = 20;
export const VOLUME_PRICE_DIV_LOOKBACK = 10;
export const VOLUME_CONSISTENCY_LOOKBACK = 20;

export function computeTrendEfficiency(
    data: OHLCVData[],
    barIndex: number,
    lookback: number = TREND_EFFICIENCY_LOOKBACK
): number | null {
    if (barIndex <= 0) return null;
    const start = barIndex - lookback;
    if (start < 0) return null;

    const netMove = Math.abs(data[barIndex].close - data[start].close);
    let path = 0;
    for (let i = start + 1; i <= barIndex; i++) {
        path += Math.abs(data[i].close - data[i - 1].close);
    }
    if (path <= 0) return 0;
    return netMove / path;
}

export function computeAtrRegimeRatio(
    atr: Array<number | null>,
    barIndex: number,
    lookback: number = ATR_REGIME_LOOKBACK
): number | null {
    const currentAtr = atr[barIndex];
    if (currentAtr === null || currentAtr === undefined || currentAtr <= 0) return null;

    const start = Math.max(0, barIndex - lookback + 1);
    let sum = 0;
    let count = 0;
    for (let i = start; i <= barIndex; i++) {
        const value = atr[i];
        if (value === null || value === undefined || value <= 0) continue;
        sum += value;
        count++;
    }
    if (count < 3) return null;

    const meanAtr = sum / count;
    if (meanAtr <= 0) return null;
    return currentAtr / meanAtr;
}

export function computeBodyPercent(candle: OHLCVData): number | null {
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return null;
    return (Math.abs(candle.close - candle.open) / range) * 100;
}

export function computeWickSkew(candle: OHLCVData): number | null {
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return null;

    const bodyHigh = Math.max(candle.open, candle.close);
    const bodyLow = Math.min(candle.open, candle.close);
    const upperWick = Math.max(0, candle.high - bodyHigh);
    const lowerWick = Math.max(0, bodyLow - candle.low);
    return ((upperWick - lowerWick) / range) * 100;
}

// ============================================================================
// Volume-Derived Metrics
// ============================================================================

/**
 * Volume Trend — is volume *building* into this entry?
 * Short EMA of volume / Long EMA of volume.
 * >1 = volume accelerating (accumulation), <1 = volume fading (distribution).
 * Fading volume at entry often signals weak conviction and a higher chance of failure.
 */
export function computeVolumeTrend(
    volumes: number[],
    barIndex: number,
    shortPeriod: number = VOLUME_TREND_SHORT,
    longPeriod: number = VOLUME_TREND_LONG
): number | null {
    if (barIndex < longPeriod) return null;

    // Compute short EMA up to barIndex
    const shortMult = 2 / (shortPeriod + 1);
    let shortEma = volumes[0];
    for (let i = 1; i <= barIndex; i++) {
        shortEma = (volumes[i] - shortEma) * shortMult + shortEma;
    }

    // Compute long EMA up to barIndex
    const longMult = 2 / (longPeriod + 1);
    let longEma = volumes[0];
    for (let i = 1; i <= barIndex; i++) {
        longEma = (volumes[i] - longEma) * longMult + longEma;
    }

    if (longEma <= 0) return null;
    return shortEma / longEma;
}

/**
 * Relative Volume Burst — how extreme is this bar's volume vs recent history?
 * Z-score: (currentVol - mean) / stddev over lookback.
 * Higher = more unusual spike. Helps separate genuine interest from noise blips.
 * Typical range: -2..+5.
 */
export function computeRelativeVolumeBurst(
    volumes: number[],
    barIndex: number,
    lookback: number = VOLUME_BURST_LOOKBACK
): number | null {
    const start = barIndex - lookback + 1;
    if (start < 0) return null;

    let sum = 0;
    for (let i = start; i <= barIndex; i++) sum += volumes[i];
    const mean = sum / lookback;
    if (mean <= 0) return null;

    let variance = 0;
    for (let i = start; i <= barIndex; i++) variance += (volumes[i] - mean) ** 2;
    const stddev = Math.sqrt(variance / lookback);
    if (stddev <= 0) return 0;

    return (volumes[barIndex] - mean) / stddev;
}

/**
 * Volume-Price Divergence — are price and volume telling the same story?
 * Counts how many of the last N bars have volume and price moving in the same direction.
 * Returns -1..1: +1 = perfect agreement (both rising or both falling),
 * -1 = perfect divergence (price up but volume down, or vice versa).
 * Divergence at entry = weak move likely to fail.
 */
export function computeVolumePriceDivergence(
    data: OHLCVData[],
    barIndex: number,
    lookback: number = VOLUME_PRICE_DIV_LOOKBACK
): number | null {
    if (barIndex < lookback) return null;

    let agreements = 0;
    for (let i = barIndex - lookback + 1; i <= barIndex; i++) {
        const priceUp = data[i].close >= data[i - 1].close;
        const volumeUp = data[i].volume >= data[i - 1].volume;
        // Agreement: both up or both down
        if (priceUp === volumeUp) agreements++;
    }

    // Normalize to -1..1 (0.5 agreement rate → 0, 1.0 → +1, 0.0 → -1)
    return (agreements / lookback) * 2 - 1;
}

/**
 * Volume Consistency — is volume steady or erratic over the lookback?
 * Coefficient of variation: stddev / mean.
 * Lower = steady participation (institutional), higher = erratic (retail noise).
 * Typical range: 0.3..2.0.
 */
export function computeVolumeConsistency(
    volumes: number[],
    barIndex: number,
    lookback: number = VOLUME_CONSISTENCY_LOOKBACK
): number | null {
    const start = barIndex - lookback + 1;
    if (start < 0) return null;

    let sum = 0;
    for (let i = start; i <= barIndex; i++) sum += volumes[i];
    const mean = sum / lookback;
    if (mean <= 0) return null;

    let variance = 0;
    for (let i = start; i <= barIndex; i++) variance += (volumes[i] - mean) ** 2;

    return Math.sqrt(variance / lookback) / mean;
}
