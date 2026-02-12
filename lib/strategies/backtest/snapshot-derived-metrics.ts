import { OHLCVData } from '../../types/index';

export const TREND_EFFICIENCY_LOOKBACK = 10;
export const ATR_REGIME_LOOKBACK = 20;
export const VOLUME_TREND_SHORT = 5;
export const VOLUME_TREND_LONG = 20;
export const VOLUME_BURST_LOOKBACK = 20;
export const VOLUME_PRICE_DIV_LOOKBACK = 10;
export const VOLUME_CONSISTENCY_LOOKBACK = 20;
export const MOMENTUM_CONSISTENCY_LOOKBACK = 3;
export const TF_60_LOOKBACK_MINUTES = 60;
export const TF_90_LOOKBACK_MINUTES = 90;
export const TF_120_LOOKBACK_MINUTES = 120;
export const TF_480_LOOKBACK_MINUTES = 480;

export type EntryDirection = 'long' | 'short';

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

export function computeDirectionalCloseLocation(candle: OHLCVData, direction: EntryDirection): number | null {
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return null;

    const score = direction === 'short'
        ? ((candle.high - candle.close) / range) * 100
        : ((candle.close - candle.low) / range) * 100;
    return clamp(score, 0, 100);
}

export function computeOppositeWickPercent(candle: OHLCVData, direction: EntryDirection): number | null {
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return null;

    const bodyHigh = Math.max(candle.open, candle.close);
    const bodyLow = Math.min(candle.open, candle.close);
    const oppositeWick = direction === 'short'
        ? Math.max(0, bodyLow - candle.low)
        : Math.max(0, candle.high - bodyHigh);
    return clamp((oppositeWick / range) * 100, 0, 100);
}

export function computeRangeAtrMultiple(
    candle: OHLCVData,
    atr: number | null | undefined
): number | null {
    if (atr === null || atr === undefined || !Number.isFinite(atr) || atr <= 0) return null;
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return null;
    return range / atr;
}

export function computeMomentumConsistency(
    data: OHLCVData[],
    barIndex: number,
    direction: EntryDirection,
    lookback: number = MOMENTUM_CONSISTENCY_LOOKBACK
): number | null {
    if (lookback <= 0 || barIndex - lookback + 1 < 0) return null;

    let supportive = 0;
    const start = barIndex - lookback + 1;
    for (let i = start; i <= barIndex; i++) {
        const candle = data[i];
        const supports = direction === 'short'
            ? candle.close < candle.open
            : candle.close > candle.open;
        if (supports) supportive++;
    }

    return (supportive / lookback) * 100;
}

export function computeBreakQuality(
    candle: OHLCVData,
    direction: EntryDirection,
    triggerPrice: number | null | undefined
): number | null {
    if (triggerPrice === null || triggerPrice === undefined || !Number.isFinite(triggerPrice)) return null;
    const range = candle.high - candle.low;
    if (!Number.isFinite(range) || range <= 0) return null;

    // Positive distance means the candle closes beyond the trigger in the entry direction.
    const directionalDistance = direction === 'short'
        ? (triggerPrice - candle.close) / range
        : (candle.close - triggerPrice) / range;

    return clamp(50 + (directionalDistance * 250), 0, 100);
}

export function computeEntryQualityScore(metrics: {
    bodyPercent: number | null;
    closeLocation: number | null;
    oppositeWickPercent: number | null;
    rangeAtrMultiple: number | null;
    momentumConsistency: number | null;
    breakQuality: number | null;
}): number | null {
    const parts: Array<{ value: number; weight: number }> = [];

    const bodyComponent = bodyToQuality(metrics.bodyPercent);
    if (bodyComponent !== null) parts.push({ value: bodyComponent, weight: 0.2 });

    if (metrics.closeLocation !== null && Number.isFinite(metrics.closeLocation)) {
        parts.push({ value: clamp(metrics.closeLocation, 0, 100), weight: 0.17 });
    }

    if (metrics.oppositeWickPercent !== null && Number.isFinite(metrics.oppositeWickPercent)) {
        const oppositeWickComponent = clamp(100 - (metrics.oppositeWickPercent * 1.8), 0, 100);
        parts.push({ value: oppositeWickComponent, weight: 0.15 });
    }

    const rangeComponent = rangeAtrToQuality(metrics.rangeAtrMultiple);
    if (rangeComponent !== null) parts.push({ value: rangeComponent, weight: 0.16 });

    if (metrics.momentumConsistency !== null && Number.isFinite(metrics.momentumConsistency)) {
        parts.push({ value: clamp(metrics.momentumConsistency, 0, 100), weight: 0.16 });
    }

    if (metrics.breakQuality !== null && Number.isFinite(metrics.breakQuality)) {
        parts.push({ value: clamp(metrics.breakQuality, 0, 100), weight: 0.16 });
    }

    if (parts.length === 0) return null;

    let weightedSum = 0;
    let totalWeight = 0;
    for (const part of parts) {
        weightedSum += part.value * part.weight;
        totalWeight += part.weight;
    }
    if (totalWeight <= 0) return null;
    return clamp(weightedSum / totalWeight, 0, 100);
}

export function computeDirectionalPerformancePercent(
    data: OHLCVData[],
    barIndex: number,
    direction: EntryDirection,
    lookbackMinutes: number
): number | null {
    if (lookbackMinutes <= 0 || barIndex <= 0 || barIndex >= data.length) return null;

    const currentClose = data[barIndex].close;
    if (!Number.isFinite(currentClose) || currentClose <= 0) return null;

    const lookbackIndex = findLookbackIndexByMinutes(data, barIndex, lookbackMinutes);
    if (lookbackIndex === null || lookbackIndex < 0 || lookbackIndex >= barIndex) return null;

    const baseClose = data[lookbackIndex].close;
    if (!Number.isFinite(baseClose) || baseClose <= 0) return null;

    const rawReturnPct = ((currentClose - baseClose) / baseClose) * 100;
    return direction === 'short' ? -rawReturnPct : rawReturnPct;
}

export function computeDirectionalConfluencePercent(
    data: OHLCVData[],
    barIndex: number,
    direction: EntryDirection
): number | null {
    const weightedPerformances = [
        { value: computeDirectionalPerformancePercent(data, barIndex, direction, TF_60_LOOKBACK_MINUTES), weight: 0.36 },
        { value: computeDirectionalPerformancePercent(data, barIndex, direction, TF_90_LOOKBACK_MINUTES), weight: 0.24 },
        { value: computeDirectionalPerformancePercent(data, barIndex, direction, TF_120_LOOKBACK_MINUTES), weight: 0.22 },
        { value: computeDirectionalPerformancePercent(data, barIndex, direction, TF_480_LOOKBACK_MINUTES), weight: 0.18 },
    ].filter((entry): entry is { value: number; weight: number } => entry.value !== null && Number.isFinite(entry.value));

    if (weightedPerformances.length < 2) return null;

    let weightedSum = 0;
    let totalWeight = 0;
    for (const entry of weightedPerformances) {
        weightedSum += entry.value * entry.weight;
        totalWeight += entry.weight;
    }
    if (totalWeight <= 0) return null;

    const weightedMean = weightedSum / totalWeight;

    let weightedVariance = 0;
    let weightedCounterTrend = 0;
    for (const entry of weightedPerformances) {
        const delta = entry.value - weightedMean;
        weightedVariance += entry.weight * (delta * delta);
        if (entry.value < 0) {
            weightedCounterTrend += entry.weight * Math.abs(entry.value);
        }
    }

    const weightedStdDev = Math.sqrt(weightedVariance / totalWeight);
    const counterTrendMagnitude = weightedCounterTrend / totalWeight;
    const disagreementPenalty = weightedStdDev * 0.45;
    const counterTrendPenalty = counterTrendMagnitude * 1.1;

    return weightedMean - disagreementPenalty - counterTrendPenalty;
}

function bodyToQuality(bodyPercent: number | null): number | null {
    if (bodyPercent === null || !Number.isFinite(bodyPercent)) return null;
    if (bodyPercent <= 15) return 0;
    if (bodyPercent >= 75) return 100;
    return ((bodyPercent - 15) / 60) * 100;
}

function rangeAtrToQuality(rangeAtrMultiple: number | null): number | null {
    if (rangeAtrMultiple === null || !Number.isFinite(rangeAtrMultiple) || rangeAtrMultiple <= 0) return null;

    const softLow = 0.25;
    const idealLow = 0.6;
    const idealHigh = 1.8;
    const softHigh = 3;

    if (rangeAtrMultiple >= idealLow && rangeAtrMultiple <= idealHigh) return 100;
    if (rangeAtrMultiple <= softLow || rangeAtrMultiple >= softHigh) return 0;
    if (rangeAtrMultiple < idealLow) {
        return ((rangeAtrMultiple - softLow) / (idealLow - softLow)) * 100;
    }
    return ((softHigh - rangeAtrMultiple) / (softHigh - idealHigh)) * 100;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function findLookbackIndexByMinutes(
    data: OHLCVData[],
    barIndex: number,
    lookbackMinutes: number
): number | null {
    const currentMs = timeToMs(data[barIndex].time);
    if (currentMs === null) return null;

    const targetMs = currentMs - (lookbackMinutes * 60_000);
    for (let i = barIndex - 1; i >= 0; i--) {
        const barMs = timeToMs(data[i].time);
        if (barMs === null) continue;
        if (barMs <= targetMs) return i;
    }
    return null;
}

function timeToMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Lightweight Charts intraday numeric times are usually seconds.
        return value > 9_999_999_999 ? Math.floor(value) : Math.floor(value * 1000);
    }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    if (value && typeof value === 'object' && 'year' in (value as Record<string, unknown>)) {
        const day = value as { year: number; month: number; day: number };
        if (!Number.isFinite(day.year) || !Number.isFinite(day.month) || !Number.isFinite(day.day)) return null;
        return Date.UTC(day.year, day.month - 1, day.day);
    }
    return null;
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
