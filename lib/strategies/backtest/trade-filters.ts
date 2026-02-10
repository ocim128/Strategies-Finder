
import { OHLCVData } from '../../types/index';
import { NormalizedSettings, IndicatorSeries } from '../../types/backtest';
import {
    computeAtrRegimeRatio,
    computeBodyPercent,
    computeTrendEfficiency,
    computeWickSkew
} from './snapshot-derived-metrics';

export const MARKET_MODE_DEFAULT_EMA_PERIOD = 200;
export const MARKET_MODE_SLOPE_LOOKBACK = 20;
export const MARKET_MODE_SLOPE_THRESHOLD = 0.0008;
export const MARKET_MODE_SIDEWAY_DISTANCE = 0.015;
export const TRADE_FILTER_DEFAULT_TREND_EMA_PERIOD = 50;
export const TRADE_FILTER_DEFAULT_ADX_MIN = 20;

export function resolveTrendPeriod(config: NormalizedSettings): number {
    if (config.trendEmaPeriod > 0) return config.trendEmaPeriod;
    if (config.tradeFilterMode === 'trend') return TRADE_FILTER_DEFAULT_TREND_EMA_PERIOD;
    return config.marketMode === 'all' ? 0 : MARKET_MODE_DEFAULT_EMA_PERIOD;
}

export function passesTradeFilter(
    data: OHLCVData[],
    entryIndex: number,
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: 'long' | 'short'
): boolean {
    if (config.tradeFilterMode === 'none') return true;

    if (config.tradeFilterMode === 'close') {
        if (entryIndex <= 0) return false;

        const lookback = config.confirmLookback;
        const start = Math.max(0, entryIndex - lookback);
        if (tradeDirection === 'short') {
            let lowestLow = Infinity;
            for (let i = start; i < entryIndex; i++) {
                lowestLow = Math.min(lowestLow, data[i].low);
            }
            return data[entryIndex].close < lowestLow;
        }

        let highestHigh = -Infinity;
        for (let i = start; i < entryIndex; i++) {
            highestHigh = Math.max(highestHigh, data[i].high);
        }

        return data[entryIndex].close > highestHigh;
    }

    if (config.tradeFilterMode === 'volume') {
        const volumeSma = indicators.volumeSma[entryIndex];
        if (volumeSma === null || volumeSma === undefined) return false;
        return data[entryIndex].volume >= volumeSma * config.volumeMultiplier;
    }

    if (config.tradeFilterMode === 'rsi') {
        const rsi = indicators.rsi[entryIndex];
        if (rsi === null || rsi === undefined) return false;
        return tradeDirection === 'short' ? rsi <= config.rsiBearish : rsi >= config.rsiBullish;
    }

    if (config.tradeFilterMode === 'trend') {
        const ema = indicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined) return false;

        const slopeLookback = Math.max(1, config.confirmLookback);
        const slopeIndex = entryIndex - slopeLookback;
        if (slopeIndex < 0) return false;
        const prevEma = indicators.emaTrend[slopeIndex];
        if (prevEma === null || prevEma === undefined) return false;

        if (tradeDirection === 'short') {
            return data[entryIndex].close < ema && ema < prevEma;
        }
        return data[entryIndex].close > ema && ema > prevEma;
    }

    if (config.tradeFilterMode === 'adx') {
        const adx = indicators.adx[entryIndex];
        if (adx === null || adx === undefined) return false;
        const minAdx = config.adxMin > 0 ? config.adxMin : TRADE_FILTER_DEFAULT_ADX_MIN;
        return adx >= minAdx;
    }

    return true;
}

export function passesRegimeFilters(
    data: OHLCVData[],
    entryIndex: number,
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: 'long' | 'short'
): boolean {
    const isShort = tradeDirection === 'short';
    if (config.marketMode !== 'all') {
        const ema = indicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined || ema === 0) return false;

        const slopeIndex = entryIndex - MARKET_MODE_SLOPE_LOOKBACK;
        if (slopeIndex < 0) return false;
        const prevEma = indicators.emaTrend[slopeIndex];
        if (prevEma === null || prevEma === undefined || prevEma === 0) return false;

        const close = data[entryIndex].close;
        const slope = (ema - prevEma) / prevEma;
        const distance = Math.abs((close - ema) / ema);
        const isUptrend = close > ema && slope >= MARKET_MODE_SLOPE_THRESHOLD;
        const isDowntrend = close < ema && slope <= -MARKET_MODE_SLOPE_THRESHOLD;
        const isSideway = Math.abs(slope) <= MARKET_MODE_SLOPE_THRESHOLD && distance <= MARKET_MODE_SIDEWAY_DISTANCE;

        if (config.marketMode === 'uptrend') {
            if (isShort || !isUptrend) return false;
        } else if (config.marketMode === 'downtrend') {
            if (!isShort || !isDowntrend) return false;
        } else if (!isSideway) {
            return false;
        }
    }

    if (config.trendEmaPeriod > 0) {
        const ema = indicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined) return false;
        if (isShort) {
            if (data[entryIndex].close >= ema) return false;
        } else if (data[entryIndex].close <= ema) {
            return false;
        }

        if (config.trendEmaSlopeBars > 0) {
            const slopeIndex = entryIndex - config.trendEmaSlopeBars;
            if (slopeIndex < 0) return false;
            const previousEma = indicators.emaTrend[slopeIndex];
            if (previousEma === null || previousEma === undefined) return false;
            if (isShort ? ema >= previousEma : ema <= previousEma) return false;
        }
    }

    if (config.atrPercentMin > 0 || config.atrPercentMax > 0) {
        const atr = indicators.atr[entryIndex];
        if (atr === null || atr === undefined) return false;
        const atrPercent = (atr / data[entryIndex].close) * 100;

        if (config.atrPercentMin > 0 && atrPercent < config.atrPercentMin) return false;
        if (config.atrPercentMax > 0 && atrPercent > config.atrPercentMax) return false;
    }

    if (config.adxMin > 0 || config.adxMax > 0) {
        const adx = indicators.adx[entryIndex];
        if (adx === null || adx === undefined) return false;

        if (config.adxMin > 0 && adx < config.adxMin) return false;
        if (config.adxMax > 0 && adx > config.adxMax) return false;
    }

    return true;
}


// ============================================================================
// Snapshot-Based Filters (stackable, AND logic)
// ============================================================================

import { SnapshotIndicators } from './snapshot-capture';

/**
 * Check all snapshot-based filters.  These are evaluated with AND logic —
 * the trade is only allowed if ALL enabled filters pass.
 * They work independently of (and stack with) the legacy `tradeFilterMode`.
 *
 * Returns `true` if the entry passes all enabled snapshot filters.
 */
export function passesSnapshotFilters(
    data: OHLCVData[],
    entryIndex: number,
    config: NormalizedSettings,
    snapshotIndicators: SnapshotIndicators | null
): boolean {
    // If no snapshot filters are enabled, pass
    const hasAny =
        config.snapshotAtrPercentMin > 0 ||
        config.snapshotAtrPercentMax > 0 ||
        config.snapshotVolumeRatioMin > 0 ||
        config.snapshotVolumeRatioMax > 0 ||
        config.snapshotAdxMin > 0 ||
        config.snapshotAdxMax > 0 ||
        config.snapshotEmaDistanceMin !== 0 ||
        config.snapshotEmaDistanceMax !== 0 ||
        config.snapshotRsiMin > 0 ||
        config.snapshotRsiMax > 0 ||
        config.snapshotPriceRangePosMin > 0 ||
        config.snapshotPriceRangePosMax > 0 ||
        config.snapshotBarsFromHighMax > 0 ||
        config.snapshotBarsFromLowMax > 0 ||
        config.snapshotTrendEfficiencyMin > 0 ||
        config.snapshotTrendEfficiencyMax > 0 ||
        config.snapshotAtrRegimeRatioMin > 0 ||
        config.snapshotAtrRegimeRatioMax > 0 ||
        config.snapshotBodyPercentMin > 0 ||
        config.snapshotBodyPercentMax > 0 ||
        config.snapshotWickSkewMin !== 0 ||
        config.snapshotWickSkewMax !== 0;
    if (!hasAny || !snapshotIndicators) return true;

    const close = data[entryIndex].close;

    // ATR% filter (min and/or max)
    if (config.snapshotAtrPercentMin > 0 || config.snapshotAtrPercentMax > 0) {
        const atr = snapshotIndicators.atr[entryIndex];
        if (atr === null || atr === undefined) return false;
        const atrPercent = close > 0 ? (atr / close) * 100 : 0;
        if (config.snapshotAtrPercentMin > 0 && atrPercent < config.snapshotAtrPercentMin) return false;
        if (config.snapshotAtrPercentMax > 0 && atrPercent > config.snapshotAtrPercentMax) return false;
    }

    // Volume Ratio filter (min and/or max)
    if (config.snapshotVolumeRatioMin > 0 || config.snapshotVolumeRatioMax > 0) {
        const volSma = snapshotIndicators.volumeSma[entryIndex];
        if (volSma === null || volSma === undefined || volSma <= 0) return false;
        const volumeRatio = data[entryIndex].volume / volSma;
        if (config.snapshotVolumeRatioMin > 0 && volumeRatio < config.snapshotVolumeRatioMin) return false;
        if (config.snapshotVolumeRatioMax > 0 && volumeRatio > config.snapshotVolumeRatioMax) return false;
    }

    // ADX filter (min and/or max)
    if (config.snapshotAdxMin > 0 || config.snapshotAdxMax > 0) {
        const adx = snapshotIndicators.adx[entryIndex];
        if (adx === null || adx === undefined) return false;
        if (config.snapshotAdxMin > 0 && adx < config.snapshotAdxMin) return false;
        if (config.snapshotAdxMax > 0 && adx > config.snapshotAdxMax) return false;
    }

    // EMA Distance filter (min and/or max)
    if (config.snapshotEmaDistanceMin !== 0 || config.snapshotEmaDistanceMax !== 0) {
        const ema = snapshotIndicators.emaTrend[entryIndex];
        if (ema === null || ema === undefined || ema <= 0) return false;
        const emaDistance = ((close - ema) / ema) * 100;
        if (config.snapshotEmaDistanceMin !== 0 && emaDistance < config.snapshotEmaDistanceMin) return false;
        if (config.snapshotEmaDistanceMax !== 0 && emaDistance > config.snapshotEmaDistanceMax) return false;
    }

    // RSI filter (min and/or max)
    if (config.snapshotRsiMin > 0 || config.snapshotRsiMax > 0) {
        const rsi = snapshotIndicators.rsi[entryIndex];
        if (rsi === null || rsi === undefined) return false;
        if (config.snapshotRsiMin > 0 && rsi < config.snapshotRsiMin) return false;
        if (config.snapshotRsiMax > 0 && rsi > config.snapshotRsiMax) return false;
    }

    // Price Range Position filter (0-1 range, min and/or max)
    if (config.snapshotPriceRangePosMin > 0 || config.snapshotPriceRangePosMax > 0) {
        const RANGE_LOOKBACK = 20;
        const start = Math.max(0, entryIndex - RANGE_LOOKBACK + 1);
        let highest = -Infinity, lowest = Infinity;
        for (let i = start; i <= entryIndex; i++) {
            if (data[i].high > highest) highest = data[i].high;
            if (data[i].low < lowest) lowest = data[i].low;
        }
        const range = highest - lowest;
        const priceRangePos = range > 0 ? (close - lowest) / range : 0.5;
        if (config.snapshotPriceRangePosMin > 0 && priceRangePos < config.snapshotPriceRangePosMin) return false;
        if (config.snapshotPriceRangePosMax > 0 && priceRangePos > config.snapshotPriceRangePosMax) return false;
    }

    // Bars from High filter (max = only enter within N bars of recent high)
    if (config.snapshotBarsFromHighMax > 0) {
        const RANGE_LOOKBACK = 20;
        const start = Math.max(0, entryIndex - RANGE_LOOKBACK + 1);
        let highBar = entryIndex, highest = -Infinity;
        for (let i = start; i <= entryIndex; i++) {
            if (data[i].high > highest) { highest = data[i].high; highBar = i; }
        }
        if (entryIndex - highBar > config.snapshotBarsFromHighMax) return false;
    }

    // Bars from Low filter (max = only enter within N bars of recent low)
    if (config.snapshotBarsFromLowMax > 0) {
        const RANGE_LOOKBACK = 20;
        const start = Math.max(0, entryIndex - RANGE_LOOKBACK + 1);
        let lowBar = entryIndex, lowest = Infinity;
        for (let i = start; i <= entryIndex; i++) {
            if (data[i].low < lowest) { lowest = data[i].low; lowBar = i; }
        }
        if (entryIndex - lowBar > config.snapshotBarsFromLowMax) return false;
    }

    // Trend efficiency filter (0-1, min and/or max)
    if (config.snapshotTrendEfficiencyMin > 0 || config.snapshotTrendEfficiencyMax > 0) {
        const trendEfficiency = computeTrendEfficiency(data, entryIndex);
        if (trendEfficiency === null || trendEfficiency === undefined) return false;
        if (config.snapshotTrendEfficiencyMin > 0 && trendEfficiency < config.snapshotTrendEfficiencyMin) return false;
        if (config.snapshotTrendEfficiencyMax > 0 && trendEfficiency > config.snapshotTrendEfficiencyMax) return false;
    }

    // ATR regime ratio filter (min and/or max)
    if (config.snapshotAtrRegimeRatioMin > 0 || config.snapshotAtrRegimeRatioMax > 0) {
        const atrRegimeRatio = computeAtrRegimeRatio(snapshotIndicators.atr, entryIndex);
        if (atrRegimeRatio === null || atrRegimeRatio === undefined) return false;
        if (config.snapshotAtrRegimeRatioMin > 0 && atrRegimeRatio < config.snapshotAtrRegimeRatioMin) return false;
        if (config.snapshotAtrRegimeRatioMax > 0 && atrRegimeRatio > config.snapshotAtrRegimeRatioMax) return false;
    }

    // Candle body conviction filter (% of bar range, min and/or max)
    if (config.snapshotBodyPercentMin > 0 || config.snapshotBodyPercentMax > 0) {
        const bodyPercent = computeBodyPercent(data[entryIndex]);
        if (bodyPercent === null || bodyPercent === undefined) return false;
        if (config.snapshotBodyPercentMin > 0 && bodyPercent < config.snapshotBodyPercentMin) return false;
        if (config.snapshotBodyPercentMax > 0 && bodyPercent > config.snapshotBodyPercentMax) return false;
    }

    // Wick skew filter (-100..100, min and/or max)
    if (config.snapshotWickSkewMin !== 0 || config.snapshotWickSkewMax !== 0) {
        const wickSkew = computeWickSkew(data[entryIndex]);
        if (wickSkew === null || wickSkew === undefined) return false;
        if (config.snapshotWickSkewMin !== 0 && wickSkew < config.snapshotWickSkewMin) return false;
        if (config.snapshotWickSkewMax !== 0 && wickSkew > config.snapshotWickSkewMax) return false;
    }

    return true;
}
