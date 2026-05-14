import { OHLCVData } from '../../types/index';
import { NormalizedSettings, IndicatorSeries } from '../../types/backtest';

export const MARKET_MODE_DEFAULT_EMA_PERIOD = 200;
export const MARKET_MODE_SLOPE_LOOKBACK = 20;
export const MARKET_MODE_SLOPE_THRESHOLD = 0.0008;
export const MARKET_MODE_SIDEWAY_DISTANCE = 0.015;

export function resolveTrendPeriod(config: NormalizedSettings): number {
    if (config.trendEmaPeriod > 0) return config.trendEmaPeriod;
    return config.marketMode === 'all' ? 0 : MARKET_MODE_DEFAULT_EMA_PERIOD;
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
