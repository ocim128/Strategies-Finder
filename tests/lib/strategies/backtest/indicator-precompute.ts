
import { BacktestSettings, OHLCVData } from '../../types/index';
import { calculateADX, calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';
import { getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { IndicatorSeries, NormalizedSettings, PrecomputedIndicators } from '../../types/backtest';
import { normalizeBacktestSettings } from './backtest-utils';
import {
    resolveExecutionTrendPeriod,
    resolveHtfBiasPeriod,
    resolveTrendPeriod,
} from './trade-filters';

const MAX_SETTINGS_CACHE_PER_DATASET = 24;
const indicatorCache = new WeakMap<OHLCVData[], Map<string, PrecomputedIndicators>>();

function buildIndicatorCacheKey(config: NormalizedSettings): string {
    return [
        config.atrPeriod,
        config.atrPercentMin,
        config.atrPercentMax,
        config.partialTakeProfitAtR,
        config.breakEvenAtR,
        config.tradeFilterMode,
        config.trendEmaPeriod,
        config.htfBiasEmaPeriod,
        config.executionTrendEmaPeriod,
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

    const atr = calculateATR(highs, lows, closes, config.atrPeriod);
    const trendPeriod = resolveTrendPeriod(config);
    const emaTrend = trendPeriod > 0 ? calculateEMA(closes, trendPeriod) : [];
    const useFastTrendFilter = config.tradeFilterMode === 'trend_exec_alignment'
        || config.tradeFilterMode === 'trend_persistence'
        || config.tradeFilterMode === 'trend_slope_strength'
        || config.tradeFilterMode === 'trend_no_chase'
        || config.tradeFilterMode === 'trend_hysteresis'
        || config.tradeFilterMode === 'trend_mtf_stack';
    const useSlowTrendFilter = config.tradeFilterMode === 'trend_htf_bias'
        || config.tradeFilterMode === 'trend_mtf_stack';
    const htfBiasPeriod = resolveHtfBiasPeriod(config);
    const executionTrendPeriod = resolveExecutionTrendPeriod(config);
    const emaFast = useFastTrendFilter ? calculateEMA(closes, executionTrendPeriod) : [];
    const emaSlow = useSlowTrendFilter ? calculateEMA(closes, htfBiasPeriod) : [];

    const useAdx = config.tradeFilterMode === 'adx'
        || config.tradeFilterMode === 'trend_mtf_stack'
        || config.adxMin > 0
        || config.adxMax > 0;
    const adxPeriod = useAdx ? Math.max(1, config.adxPeriod) : 0;
    const adx = useAdx ? calculateADX(highs, lows, closes, adxPeriod) : [];

    const volumeSma = config.tradeFilterMode === 'volume'
        ? calculateSMA(volumes, config.volumeSmaPeriod)
        : [];
    const rsi = config.tradeFilterMode === 'rsi'
        ? calculateRSI(closes, config.rsiPeriod)
        : [];

    const sessionVwap: (number | null)[] = [];
    const vwapDeviationStd: (number | null)[] = [];

    return {
        atr,
        emaTrend,
        emaFast,
        emaSlow,
        adx,
        volumeSma,
        rsi,
        sessionVwap,
        vwapDeviationStd,
        dataLength: data.length,
        settingsKey: buildIndicatorCacheKey(config)
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
    const config = normalizeBacktestSettings(settings);
    const cacheKey = buildIndicatorCacheKey(config);
    let computed: PrecomputedIndicators | undefined;
    if (
        precomputed &&
        precomputed.dataLength === data.length &&
        precomputed.settingsKey === cacheKey
    ) {
        computed = precomputed;
    } else {
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
        emaFast: computed.emaFast,
        emaSlow: computed.emaSlow,
        adx: computed.adx,
        volumeSma: computed.volumeSma,
        rsi: computed.rsi,
        sessionVwap: computed.sessionVwap,
        vwapDeviationStd: computed.vwapDeviationStd
    };
}

