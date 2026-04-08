
import { OHLCVData } from '../../types/index';
import { NormalizedSettings, IndicatorSeries } from '../../types/backtest';

export const MARKET_MODE_DEFAULT_EMA_PERIOD = 200;
export const MARKET_MODE_SLOPE_LOOKBACK = 20;
export const MARKET_MODE_SLOPE_THRESHOLD = 0.0008;
export const MARKET_MODE_SIDEWAY_DISTANCE = 0.015;
export const TRADE_FILTER_DEFAULT_TREND_EMA_PERIOD = 50;
export const TRADE_FILTER_DEFAULT_ADX_MIN = 20;
export const TRADE_FILTER_DEFAULT_HTF_DRIFT_THRESHOLD_PCT = 2;
export const TRADE_FILTER_DEFAULT_HTF_DRIFT_BARS = 5;
export const TRADE_FILTER_HTF_BIAS_EMA_PERIOD = 200;
export const TRADE_FILTER_HTF_BIAS_SLOPE_LOOKBACK = 20;
export const TRADE_FILTER_HTF_BIAS_SLOPE_THRESHOLD = 0.001;
export const TRADE_FILTER_EXEC_ALIGNMENT_EMA_PERIOD = 50;
export const TRADE_FILTER_EXEC_ALIGNMENT_SLOPE_LOOKBACK = 5;

export function resolveTrendPeriod(config: NormalizedSettings): number {
    if (config.trendEmaPeriod > 0) return config.trendEmaPeriod;
    if (config.tradeFilterMode === 'trend') return TRADE_FILTER_DEFAULT_TREND_EMA_PERIOD;
    return config.marketMode === 'all' ? 0 : MARKET_MODE_DEFAULT_EMA_PERIOD;
}

export function resolveHtfBiasPeriod(config: NormalizedSettings): number {
    if (config.htfBiasEmaPeriod > 0) return Math.round(config.htfBiasEmaPeriod);
    return TRADE_FILTER_HTF_BIAS_EMA_PERIOD;
}

export function resolveExecutionTrendPeriod(config: NormalizedSettings): number {
    if (config.executionTrendEmaPeriod > 0) return Math.round(config.executionTrendEmaPeriod);
    return TRADE_FILTER_EXEC_ALIGNMENT_EMA_PERIOD;
}

function readIndicator(series: (number | null)[], index: number): number | null {
    const value = series[index];
    return value === null || value === undefined || !Number.isFinite(value) ? null : value;
}

function passesHtfBiasFilter(
    data: OHLCVData[],
    entryIndex: number,
    config: NormalizedSettings,
    indicators: IndicatorSeries,
    tradeDirection: 'long' | 'short'
): boolean {
    const htfBiasPeriod = resolveHtfBiasPeriod(config);
    if (entryIndex < htfBiasPeriod - 1) return false;

    const ema = readIndicator(indicators.emaSlow, entryIndex);
    if (ema === null || ema === 0) return false;

    const slopeIndex = entryIndex - TRADE_FILTER_HTF_BIAS_SLOPE_LOOKBACK;
    if (slopeIndex < 0) return false;
    const previousEma = readIndicator(indicators.emaSlow, slopeIndex);
    if (previousEma === null || previousEma === 0) return false;

    const close = data[entryIndex].close;
    const slope = (ema - previousEma) / previousEma;
    if (tradeDirection === 'short') {
        return close < ema && slope <= -TRADE_FILTER_HTF_BIAS_SLOPE_THRESHOLD;
    }
    return close > ema && slope >= TRADE_FILTER_HTF_BIAS_SLOPE_THRESHOLD;
}

function passesExecutionAlignmentFilter(
    data: OHLCVData[],
    entryIndex: number,
    indicators: IndicatorSeries,
    tradeDirection: 'long' | 'short'
): boolean {
    const ema = readIndicator(indicators.emaFast, entryIndex);
    if (ema === null || ema === 0) return false;

    const slopeIndex = entryIndex - TRADE_FILTER_EXEC_ALIGNMENT_SLOPE_LOOKBACK;
    if (slopeIndex < 0) return false;
    const previousEma = readIndicator(indicators.emaFast, slopeIndex);
    if (previousEma === null || previousEma === 0) return false;

    const close = data[entryIndex].close;
    if (tradeDirection === 'short') {
        return close < ema && ema < previousEma;
    }
    return close > ema && ema > previousEma;
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

    if (config.tradeFilterMode === 'htf_drift') {
        // HTF drift not supported after removing snapshot-derived-metrics
        return false;
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

    if (config.tradeFilterMode === 'trend_htf_bias') {
        return passesHtfBiasFilter(data, entryIndex, config, indicators, tradeDirection);
    }

    if (config.tradeFilterMode === 'trend_exec_alignment') {
        return passesExecutionAlignmentFilter(data, entryIndex, indicators, tradeDirection);
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



