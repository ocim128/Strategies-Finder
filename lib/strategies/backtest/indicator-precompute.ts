
import { BacktestSettings, OHLCVData, TradeSizingMode } from '../../types/index';
import { calculateADX, calculateATR, calculateEMA } from '../indicators';
import { getCloses, getHighs, getLows } from '../strategy-helpers';
import { IndicatorSeries, NormalizedSettings, PrecomputedIndicators } from '../../types/backtest';
import { normalizeBacktestSettings } from './backtest-utils';
import { resolveTrendPeriod } from './regime-filters';

const MAX_SETTINGS_CACHE_PER_DATASET = 24;
const indicatorCache = new WeakMap<OHLCVData[], Map<string, PrecomputedIndicators>>();

function buildIndicatorCacheKey(config: NormalizedSettings, includeAtr = true): string {
    return [
        config.atrPeriod,
        config.atrPercentMin,
        config.atrPercentMax,
        config.partialTakeProfitAtR,
        config.breakEvenAtR,
        config.trendEmaPeriod,
        config.marketMode,
        config.adxPeriod,
        config.adxMin,
        config.adxMax,
    ].join('|') + (includeAtr ? '' : '|no-atr');
}

function precomputeIndicatorsFromConfig(
    data: OHLCVData[],
    config: NormalizedSettings,
    includeAtr = true,
): PrecomputedIndicators {
    const useAdx = config.adxMin > 0
        || config.adxMax > 0;
    const highs = includeAtr || useAdx ? getHighs(data) : [];
    const lows = includeAtr || useAdx ? getLows(data) : [];
    const trendPeriod = resolveTrendPeriod(config);
    const closes = includeAtr || useAdx || trendPeriod > 0 ? getCloses(data) : [];
    const atr = includeAtr ? calculateATR(highs, lows, closes, config.atrPeriod) : [];
    const emaTrend = trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : [];
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = useAdx ? calculateADX(highs, lows, closes, adxPeriod) : [];

    return {
        atr,
        emaTrend,
        adx,
        dataLength: data.length,
        settingsKey: buildIndicatorCacheKey(config, includeAtr)
    };
}

function getOrCreatePrecomputedIndicators(
    data: OHLCVData[],
    config: NormalizedSettings,
    includeAtr = true,
): PrecomputedIndicators {
    const cacheKey = buildIndicatorCacheKey(config, includeAtr);
    let datasetCache = indicatorCache.get(data);
    if (!datasetCache) {
        datasetCache = new Map<string, PrecomputedIndicators>();
        indicatorCache.set(data, datasetCache);
    }

    let computed = datasetCache.get(cacheKey);
    if (!computed || computed.dataLength !== data.length) {
        computed = precomputeIndicatorsFromConfig(data, config, includeAtr);
        if (datasetCache.size >= MAX_SETTINGS_CACHE_PER_DATASET) {
            const oldestKey = datasetCache.keys().next().value;
            if (oldestKey !== undefined) {
                datasetCache.delete(oldestKey);
            }
        }
        datasetCache.set(cacheKey, computed);
    }
    return computed;
}

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
    return getOrCreatePrecomputedIndicators(data, config);
}

/**
 * Resolve indicators from an already-normalized config. Use this when the
 * caller has already normalized settings (avoids the redundant second
 * normalization that {@link resolveIndicators} would do).
 */
export function resolveIndicatorsFromConfig(
    data: OHLCVData[],
    config: NormalizedSettings,
    precomputed?: PrecomputedIndicators,
    sizingMode?: TradeSizingMode,
): IndicatorSeries {
    // Adaptive sizing can consume ATR even without ATR risk/filter settings.
    // Unspecified sizing preserves the public precompute contract; the engine
    // supplies its mode so fixed/percent runs can omit wholly unused series.
    const includeAtr = (sizingMode !== 'fixed' && sizingMode !== 'percent')
        || config.stopLossAtr > 0 || config.takeProfitAtr > 0 || config.trailingAtr > 0
        || config.partialTakeProfitAtR > 0 || config.breakEvenAtR > 0
        || config.atrPercentMin > 0 || config.atrPercentMax > 0;
    const cacheKey = buildIndicatorCacheKey(config, includeAtr);
    let computed: PrecomputedIndicators | undefined;
    if (
        precomputed &&
        precomputed.dataLength === data.length &&
        precomputed.settingsKey === cacheKey
    ) {
        computed = precomputed;
    } else {
        computed = getOrCreatePrecomputedIndicators(data, config, includeAtr);
    }

    return {
        atr: computed.atr,
        emaTrend: computed.emaTrend,
        adx: computed.adx,
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
    return resolveIndicatorsFromConfig(data, config, precomputed);
}

