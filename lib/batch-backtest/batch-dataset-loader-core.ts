import { debugLogger } from "../debug-logger";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import { isIbkrSymbol, isMarkedLocalStockSymbol, isStockMarketSymbol } from "../local-daily-datasets";
import {
    buildSyntheticPairFromLegs,
    deriveSyntheticSymbol,
    pickSourceInterval,
    resolveEffectiveIntervalForSynthetic,
    resolveSyntheticAvailableIntervals,
} from "../../scripts/lib/synthetic-pair";
import { DATA_CHART_TOTAL_LIMIT, SYNTHETIC_TARGET_BARS } from "../data/constants";
import { parseIntervalSeconds } from "../interval-utils";
import type { OHLCVData } from "../types/strategies";
import {
    buildLegCacheKey,
    buildPairCacheKey,
    SyntheticLegCache,
} from "./synthetic-leg-cache";

const STALE_FRAGMENT_MAX_THRESHOLD = 10_000;
const STALE_FRAGMENT_MIN_THRESHOLD = 200;

export interface BatchDatasetLoaderCore {
    load(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]>;
    clearCaches(): void;
}

interface BatchDatasetLoaderCoreOptions {
    logPrefix: string;
    fetchDetached(symbol: string, interval: string, options?: { signal?: AbortSignal; offline?: boolean }): Promise<OHLCVData[]>;
    fetchHistorical(symbol: string, interval: string, limit: number, options?: { signal?: AbortSignal; offline?: boolean }): Promise<OHLCVData[]>;
}

export function createBatchDatasetLoaderCore(options: BatchDatasetLoaderCoreOptions): BatchDatasetLoaderCore {
    const legCache = new SyntheticLegCache<OHLCVData[]>(24);
    const pairCache = new SyntheticLegCache<OHLCVData[]>(16);

    async function load(symbol: string, interval: string, signal?: AbortSignal): Promise<OHLCVData[]> {
        const synthParts = parseSyntheticPairToken(symbol);
        const effectiveInterval = resolveEffectiveIntervalForSynthetic(
            symbol,
            synthParts?.baseSymbol ?? null,
            synthParts?.quoteSymbol ?? null,
            interval,
        );
        if (synthParts) {
            return loadSyntheticPair(
                synthParts.baseSymbol,
                synthParts.quoteSymbol,
                effectiveInterval,
                signal,
            );
        }

        const data = await options.fetchDetached(symbol, effectiveInterval, { signal, offline: true });
        if (signal?.aborted) return [];
        if (data.length === 0 && isIbkrSymbol(symbol)) {
            throw new Error(
                `No IBKR local candles found for ${symbol} ${effectiveInterval}. Batch uses the current chart interval; download that IBKR timeframe first or switch the chart interval to one that exists.`
            );
        }

        const staleFragmentThreshold = resolveStaleFragmentBarThreshold(effectiveInterval);
        if (data.length > 0 && data.length < staleFragmentThreshold) {
            debugLogger.warn(`${options.logPrefix}.stale_fragment_refetch`, {
                symbol, interval: effectiveInterval, cachedBars: data.length, threshold: staleFragmentThreshold,
            });
            const targetBars = DATA_CHART_TOTAL_LIMIT;
            const offlineDeep = await options.fetchHistorical(symbol, effectiveInterval, targetBars, {
                signal,
                offline: true,
            });
            if (signal?.aborted) return [];
            if (offlineDeep.length >= staleFragmentThreshold) {
                return offlineDeep;
            }
            const refetched = await options.fetchHistorical(symbol, effectiveInterval, targetBars, { signal });
            if (signal?.aborted) return [];
            return Math.max(refetched.length, offlineDeep.length) === refetched.length
                ? refetched
                : offlineDeep;
        }

        return data;
    }

    async function loadSyntheticPair(
        baseSymbol: string,
        quoteSymbol: string,
        interval: string,
        signal?: AbortSignal,
    ): Promise<OHLCVData[]> {
        if (signal?.aborted) return [];

        const syntheticSymbol = deriveSyntheticSymbol(baseSymbol, quoteSymbol);
        const diamondLeg = isStockMarketSymbol(baseSymbol) || isStockMarketSymbol(quoteSymbol);
        const available = resolveSyntheticAvailableIntervals(baseSymbol, quoteSymbol);
        const source = diamondLeg ? null : pickSourceInterval(interval, 12, available);
        const sourceInterval = source?.sourceInterval ?? interval;
        const sourceBars = Math.min(SYNTHETIC_TARGET_BARS * (source?.ratio ?? 1), DATA_CHART_TOTAL_LIMIT);
        const pairKey = buildPairCacheKey({
            syntheticSymbol,
            baseSymbol,
            quoteSymbol,
            interval,
            sourceInterval,
            sourceBars,
        });

        const cachedPair = pairCache.get(pairKey);
        if (cachedPair) {
            debugLogger.event(`${options.logPrefix}.synthetic_pair_cache_hit`, {
                syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
            });
            return cachedPair;
        }

        const promise = (async (): Promise<OHLCVData[]> => {
            if (signal?.aborted) return [];
            const result = await buildSyntheticPairFromLegs({
                baseSymbol,
                quoteSymbol,
                interval,
                targetBars: SYNTHETIC_TARGET_BARS,
                sourceBarsCap: DATA_CHART_TOTAL_LIMIT,
                fetchLeg: (legSymbol, legInterval, legBars) =>
                    getSourceSeries(legSymbol, legInterval, legBars, signal),
            });
            if (signal?.aborted) return [];
            return result.bars;
        })();

        return cacheSuccessfulLoad(pairCache, pairKey, promise, signal);
    }

    function getSourceSeries(
        sourceSymbol: string,
        sourceInterval: string,
        sourceBars: number,
        signal?: AbortSignal,
    ): Promise<OHLCVData[]> {
        const legKey = buildLegCacheKey(sourceSymbol, sourceInterval, sourceBars);
        const cached = legCache.get(legKey);
        if (cached) {
            debugLogger.event(`${options.logPrefix}.synthetic_leg_cache_hit`, { sourceSymbol, sourceInterval, sourceBars });
            return cached;
        }

        const markedLeg = isMarkedLocalStockSymbol(sourceSymbol);
        const minHealthyLegBars = Math.max(1_000, Math.floor(sourceBars * 0.25));
        const fetchLeg = (offline: boolean): Promise<OHLCVData[]> =>
            options.fetchHistorical(sourceSymbol, sourceInterval, sourceBars, {
                signal,
                ...(offline ? { offline: true } : {}),
            });
        const promise = markedLeg
            ? fetchLeg(true)
            : fetchLeg(true).then((data) =>
                    data.length >= minHealthyLegBars
                        ? data
                        : (debugLogger.warn(`${options.logPrefix}.synthetic_leg_offline_thin`, {
                                sourceSymbol,
                                sourceInterval,
                                returned: data.length,
                                expected: sourceBars,
                            }),
                            fetchLeg(false)),
                );
        return cacheSuccessfulLoad(legCache, legKey, promise, signal);
    }

    return {
        load,
        clearCaches() {
            legCache.clear();
            pairCache.clear();
        },
    };
}

function cacheSuccessfulLoad(
    cache: SyntheticLegCache<OHLCVData[]>,
    key: string,
    promise: Promise<OHLCVData[]>,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    let cached: Promise<OHLCVData[]>;
    cached = promise
        .then((data) => {
            if (signal?.aborted) {
                cache.deleteIfValue(key, cached);
                return data;
            }
            return data;
        })
        .catch((error) => {
            cache.deleteIfValue(key, cached);
            throw error;
        });
    cache.set(key, cached);
    return cached;
}

export function resolveStaleFragmentBarThreshold(interval: string): number {
    const intervalSeconds = parseIntervalSeconds(interval);
    if (intervalSeconds === null || intervalSeconds <= 0) {
        return STALE_FRAGMENT_MAX_THRESHOLD;
    }
    const oneYearBars = Math.ceil((365 * 24 * 60 * 60) / intervalSeconds);
    return Math.max(
        STALE_FRAGMENT_MIN_THRESHOLD,
        Math.min(STALE_FRAGMENT_MAX_THRESHOLD, oneYearBars),
    );
}
