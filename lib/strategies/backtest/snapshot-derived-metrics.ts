import { OHLCVData } from '../../types/index';

export const TREND_EFFICIENCY_LOOKBACK = 10;
export const ATR_REGIME_LOOKBACK = 20;

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
