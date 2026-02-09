
import { BacktestSettings, OHLCVData } from '../../types/index';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { IndicatorSeries, PrecomputedIndicators } from '../../types/backtest';
import { normalizeBacktestSettings } from './backtest-utils';
import { resolveTrendPeriod } from './trade-filters';

/**
 * Pre-computes all indicators needed for backtesting based on settings.
 * Call this ONCE before running multiple backtests with the same settings.
 * This dramatic optimization prevents recalculating indicators for each
 * parameter combination in the finder.
 * 
 * @param data OHLCV data array
 * @param settings Backtest settings that determine which indicators are needed
 * @returns Pre-computed indicators that can be passed to runBacktestCompact
 */
export function precomputeIndicators(
    data: OHLCVData[],
    settings: BacktestSettings = {}
): PrecomputedIndicators {
    const config = normalizeBacktestSettings(settings);

    const highs = getHighs(data);
    const lows = getLows(data);
    const closes = getCloses(data);
    const volumes = getVolumes(data);

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    const atr = needsAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : [];
    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : [];

    const useAdx = config.tradeFilterMode === 'adx' || config.adxMin > 0 || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = useAdx ? calculateADX(highs, lows, closes, adxPeriod) : [];

    const volumeSma = config.tradeFilterMode === 'volume'
        ? calculateSMA(volumes, config.volumeSmaPeriod)
        : [];
    const rsi = config.tradeFilterMode === 'rsi'
        ? calculateRSI(closes, config.rsiPeriod)
        : [];

    return {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi,
        dataLength: data.length
    };
}

/**
 * Helper to ensure indicators are available, either from precomputed cache or fresh calculation.
 */
export function resolveIndicators(
    data: OHLCVData[],
    settings: BacktestSettings,
    precomputed?: PrecomputedIndicators
): IndicatorSeries {
    const config = normalizeBacktestSettings(settings);
    const dataLen = data.length;

    // Check if precomputed matches current data length
    const isValidPrecomputed = precomputed && precomputed.dataLength === dataLen;

    const highs = (!isValidPrecomputed || !precomputed.atr?.length || !precomputed.adx?.length) ? getHighs(data) : [];
    const lows = (!isValidPrecomputed || !precomputed.atr?.length || !precomputed.adx?.length) ? getLows(data) : [];
    const closes = (!isValidPrecomputed || !precomputed.atr?.length || !precomputed.emaTrend?.length || !precomputed.adx?.length || !precomputed.rsi?.length) ? getCloses(data) : [];
    const volumes = (!isValidPrecomputed || !precomputed.volumeSma?.length) ? getVolumes(data) : [];

    const needsAtr =
        config.stopLossAtr > 0 ||
        config.takeProfitAtr > 0 ||
        config.trailingAtr > 0 ||
        config.atrPercentMin > 0 ||
        config.atrPercentMax > 0 ||
        config.partialTakeProfitAtR > 0 ||
        config.breakEvenAtR > 0;

    const atr = (isValidPrecomputed && precomputed.atr?.length === dataLen)
        ? precomputed.atr
        : (needsAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : []);

    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = (isValidPrecomputed && precomputed.emaTrend?.length === dataLen && trendPeriod > 0)
        ? precomputed.emaTrend
        : (trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : []);

    const useAdx = config.tradeFilterMode === 'adx' || config.adxMin > 0 || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = (isValidPrecomputed && precomputed.adx?.length === dataLen && useAdx)
        ? precomputed.adx
        : (useAdx ? calculateADX(highs, lows, closes, adxPeriod) : []);

    const volumeSma = (isValidPrecomputed && precomputed.volumeSma?.length === dataLen && config.tradeFilterMode === 'volume')
        ? precomputed.volumeSma
        : (config.tradeFilterMode === 'volume'
            ? calculateSMA(volumes, config.volumeSmaPeriod)
            : []);

    const rsi = (isValidPrecomputed && precomputed.rsi?.length === dataLen && config.tradeFilterMode === 'rsi')
        ? precomputed.rsi
        : (config.tradeFilterMode === 'rsi'
            ? calculateRSI(closes, config.rsiPeriod)
            : []);

    return {
        atr,
        emaTrend,
        adx,
        volumeSma,
        rsi
    };
}
