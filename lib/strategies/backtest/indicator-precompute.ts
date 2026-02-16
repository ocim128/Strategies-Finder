
import { BacktestSettings, OHLCVData } from '../../types/index';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { IndicatorSeries, NormalizedSettings, PrecomputedIndicators } from '../../types/backtest';
import { normalizeBacktestSettings } from './backtest-utils';
import { resolveTrendPeriod } from './trade-filters';

const MAX_SETTINGS_CACHE_PER_DATASET = 24;
const indicatorCache = new WeakMap<OHLCVData[], Map<string, PrecomputedIndicators>>();

function buildIndicatorCacheKey(config: NormalizedSettings): string {
    return [
        config.atrPeriod,
        config.stopLossAtr,
        config.takeProfitAtr,
        config.trailingAtr,
        config.atrPercentMin,
        config.atrPercentMax,
        config.partialTakeProfitAtR,
        config.breakEvenAtR,
        config.tradeFilterMode,
        config.trendEmaPeriod,
        config.marketMode,
        config.adxPeriod,
        config.adxMin,
        config.adxMax,
        config.volumeSmaPeriod,
        config.rsiPeriod
    ].join('|');
}

function precomputeIndicatorsFromConfig(
    data: OHLCVData[],
    config: NormalizedSettings
): PrecomputedIndicators {
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
    return precomputeIndicatorsFromConfig(data, config);
}

/**
 * Helper to ensure indicators are available, either from precomputed cache or fresh calculation.
 */
export function resolveIndicators(
    data: OHLCVData[],
    settings: BacktestSettings,
    precomputed?: PrecomputedIndicators
): IndicatorSeries {
    let computed: PrecomputedIndicators | undefined;
    if (precomputed && precomputed.dataLength === data.length) {
        computed = precomputed;
    } else {
        const config = normalizeBacktestSettings(settings);
        const cacheKey = buildIndicatorCacheKey(config);
        let datasetCache = indicatorCache.get(data);
        if (!datasetCache) {
            datasetCache = new Map<string, PrecomputedIndicators>();
            indicatorCache.set(data, datasetCache);
        }

        computed = datasetCache.get(cacheKey);
        if (!computed || computed.dataLength !== data.length) {
            computed = precomputeIndicatorsFromConfig(data, config);
            if (datasetCache.size >= MAX_SETTINGS_CACHE_PER_DATASET) {
                const oldestKey = datasetCache.keys().next().value;
                if (oldestKey !== undefined) {
                    datasetCache.delete(oldestKey);
                }
            }
            datasetCache.set(cacheKey, computed);
        }
    }

    return {
        atr: computed.atr,
        emaTrend: computed.emaTrend,
        adx: computed.adx,
        volumeSma: computed.volumeSma,
        rsi: computed.rsi
    };
}

