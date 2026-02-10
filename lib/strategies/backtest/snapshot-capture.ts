
import { OHLCVData, TradeSnapshot } from '../../types/index';
import { IndicatorSeries } from '../../types/backtest';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import {
    computeAtrRegimeRatio,
    computeBodyPercent,
    computeTrendEfficiency,
    computeRelativeVolumeBurst,
    computeVolumeConsistency,
    computeVolumePriceDivergence,
    computeVolumeTrend,
    computeWickSkew
} from './snapshot-derived-metrics';

/** Lookback for price range position and bars-from-high/low */
const RANGE_LOOKBACK = 20;
/** Default RSI period for snapshot */
const SNAPSHOT_RSI_PERIOD = 14;
/** Default volume SMA period for snapshot */
const SNAPSHOT_VOL_SMA_PERIOD = 20;
/** Default ADX period for snapshot */
const SNAPSHOT_ADX_PERIOD = 14;
/** Default ATR period for snapshot */
const SNAPSHOT_ATR_PERIOD = 14;
/** Default EMA period for snapshot (trend) */
const SNAPSHOT_EMA_PERIOD = 50;

/**
 * Extra indicator series computed once for snapshot capture.
 * These are always computed regardless of backtest settings,
 * ensuring all snapshot features have data.
 */
export interface SnapshotIndicators {
    rsi: (number | null)[];
    volumeSma: (number | null)[];
    adx: (number | null)[];
    atr: (number | null)[];
    emaTrend: (number | null)[];
}

/**
 * Pre-compute ALL indicators needed for snapshots.
 * Unlike the main indicator pipeline (which only computes what settings require),
 * this always computes RSI, ADX, ATR, EMA, and volume SMA so that no snapshot
 * features end up null due to missing indicators.
 */
export function computeSnapshotIndicators(
    data: OHLCVData[],
    existingIndicators: IndicatorSeries
): SnapshotIndicators {
    const len = data.length;
    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);

    // Reuse existing if available (correct length), otherwise compute fresh
    const rsi = existingIndicators.rsi.length === len
        ? existingIndicators.rsi
        : calculateRSI(closes, SNAPSHOT_RSI_PERIOD);

    const volumeSma = existingIndicators.volumeSma.length === len
        ? existingIndicators.volumeSma
        : calculateSMA(volumes, SNAPSHOT_VOL_SMA_PERIOD);

    const adx = existingIndicators.adx.length === len
        ? existingIndicators.adx
        : calculateADX(highs, lows, closes, SNAPSHOT_ADX_PERIOD);

    const atr = existingIndicators.atr.length === len
        ? existingIndicators.atr
        : calculateATR(highs, lows, closes, SNAPSHOT_ATR_PERIOD);

    const emaTrend = existingIndicators.emaTrend.length === len
        ? existingIndicators.emaTrend
        : calculateEMA(closes, SNAPSHOT_EMA_PERIOD);

    return { rsi, volumeSma, adx, atr, emaTrend };
}

/**
 * Capture an indicator snapshot at a specific bar index.
 * Called when a trade opens in the full backtest.
 */
export function captureTradeSnapshot(
    data: OHLCVData[],
    barIndex: number,
    _indicators: IndicatorSeries,
    snapshotIndicators: SnapshotIndicators
): TradeSnapshot {
    const close = data[barIndex].close;
    const volume = data[barIndex].volume;

    // RSI
    const rsi = snapshotIndicators.rsi[barIndex] ?? null;

    // ADX — now from snapshotIndicators (always computed)
    const adx = snapshotIndicators.adx[barIndex] ?? null;

    // ATR as % of price — now from snapshotIndicators (always computed)
    const atrRaw = snapshotIndicators.atr[barIndex] ?? null;
    const atrPercent = atrRaw !== null && close > 0
        ? (atrRaw / close) * 100
        : null;

    // EMA distance (% deviation from trend EMA) — now from snapshotIndicators
    const ema = snapshotIndicators.emaTrend[barIndex] ?? null;
    const emaDistance = ema !== null && ema > 0
        ? ((close - ema) / ema) * 100
        : null;

    // Volume ratio (current volume / volume SMA)
    const volSma = snapshotIndicators.volumeSma[barIndex] ?? null;
    const volumeRatio = volSma !== null && volSma > 0
        ? volume / volSma
        : null;

    // Price range position (0=at low, 1=at high over lookback)
    let priceRangePos: number | null = null;
    let barsFromHigh: number | null = null;
    let barsFromLow: number | null = null;

    const start = Math.max(0, barIndex - RANGE_LOOKBACK + 1);
    if (barIndex >= start) {
        let highest = -Infinity;
        let lowest = Infinity;
        let highBar = barIndex;
        let lowBar = barIndex;

        for (let i = start; i <= barIndex; i++) {
            if (data[i].high > highest) { highest = data[i].high; highBar = i; }
            if (data[i].low < lowest) { lowest = data[i].low; lowBar = i; }
        }

        const range = highest - lowest;
        priceRangePos = range > 0 ? (close - lowest) / range : 0.5;
        barsFromHigh = barIndex - highBar;
        barsFromLow = barIndex - lowBar;
    }

    const trendEfficiency = computeTrendEfficiency(data, barIndex);
    const atrRegimeRatio = computeAtrRegimeRatio(snapshotIndicators.atr, barIndex);
    const bodyPercent = computeBodyPercent(data[barIndex]);
    const wickSkew = computeWickSkew(data[barIndex]);

    // Volume-derived metrics
    const volumes = getVolumes(data);
    const volumeTrend = computeVolumeTrend(volumes, barIndex);
    const volumeBurst = computeRelativeVolumeBurst(volumes, barIndex);
    const volumePriceDivergence = computeVolumePriceDivergence(data, barIndex);
    const volumeConsistency = computeVolumeConsistency(volumes, barIndex);

    return {
        rsi,
        adx,
        atrPercent,
        emaDistance,
        volumeRatio,
        priceRangePos,
        barsFromHigh,
        barsFromLow,
        trendEfficiency,
        atrRegimeRatio,
        bodyPercent,
        wickSkew,
        volumeTrend,
        volumeBurst,
        volumePriceDivergence,
        volumeConsistency
    };
}
