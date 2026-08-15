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
import { resampleOHLCV } from "../strategies/resample-utils";
import type { OHLCVData } from "../types/strategies";
import {
    buildLegCacheKey,
    buildPairCacheKey,
    SyntheticLegCache,
} from "./synthetic-leg-cache";

const STALE_FRAGMENT_MAX_THRESHOLD = 10_000;
const STALE_FRAGMENT_MIN_THRESHOLD = 200;

export interface BatchDatasetLoaderCore {
    load(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]>;
    clearCaches(): void;
    /** Snapshot of in-memory + disk cache counters for benchmark diagnostics. */
    getCacheStats(): BatchDatasetCacheStats;
}

export interface BatchDatasetCacheStats {
    leg: { hits: number; misses: number; size: number; max: number };
    pair: { hits: number; misses: number; size: number; max: number };
    disk: { hits: number; misses: number; writes: number };
}

/** Per-run load counters used to split the Asset Opportunity data path. */
export interface BatchDatasetLoadDiagnostics {
    requests: number;
    syntheticPairRequests: number;
    pairCacheHits: number;
    pairCacheMisses: number;
    diskCacheHits: number;
    diskCacheMisses: number;
    legCacheHits: number;
    legCacheMisses: number;
    sourceLoads: number;
    sourceBarsRequested: number;
    sourceBarsLoaded: number;
    pairBuilds: number;
    diskCacheBypasses: number;
    timingsMs: {
        total: number;
        fingerprint: number;
        diskLookup: number;
        sourceLoads: number;
        pairBuild: number;
        pairWrite: number;
    };
}

/** Optional run-scoped state shared by concurrent dataset requests. */
export interface BatchDatasetLoadContext {
    /** Bounded external leg cache; useful when one run touches many pairs. */
    legCache?: SyntheticLegCache<OHLCVData[]>;
    /** Optional bounded pair cache; useful when a batch repeats the same assets. */
    pairCache?: SyntheticLegCache<OHLCVData[]>;
    /**
     * Optional bounded PLAIN-dataset cache for callers that reload the same
     * symbol|interval series repeatedly across iterations (Asset Opportunity
     * batch holdout sweeps). Consulted by the caller's load wrapper, NOT by
     * this loader core — synthetic legs/pairs keep flowing through their own
     * caches above, so do not store synthetic pairs here. Batch Backtest does
     * not set this field.
     */
    datasetCache?: SyntheticLegCache<OHLCVData[]>;
    /** Build synthetic pairs from the shared leg cache instead of disk I/O. */
    preferInMemorySyntheticPairs?: boolean;
    diagnostics?: BatchDatasetLoadDiagnostics;
}

export function createBatchDatasetLoadDiagnostics(): BatchDatasetLoadDiagnostics {
    return {
        requests: 0,
        syntheticPairRequests: 0,
        pairCacheHits: 0,
        pairCacheMisses: 0,
        diskCacheHits: 0,
        diskCacheMisses: 0,
        legCacheHits: 0,
        legCacheMisses: 0,
        sourceLoads: 0,
        sourceBarsRequested: 0,
        sourceBarsLoaded: 0,
        pairBuilds: 0,
        diskCacheBypasses: 0,
        timingsMs: {
            total: 0,
            fingerprint: 0,
            diskLookup: 0,
            sourceLoads: 0,
            pairBuild: 0,
            pairWrite: 0,
        },
    };
}

/** Args passed to disk-cache hooks; mirror the in-memory pairCache key inputs. */
export interface SyntheticPairDiskCacheArgs {
    pairKey: string;
    syntheticSymbol: string;
    baseSymbol: string;
    quoteSymbol: string;
    interval: string;
    sourceInterval: string;
    sourceBars: number;
}

interface BatchDatasetLoaderCoreOptions {
    logPrefix: string;
    legCacheMaxEntries?: number;
    pairCacheMaxEntries?: number;
    fetchDetached(symbol: string, interval: string, options?: { signal?: AbortSignal; offline?: boolean }): Promise<OHLCVData[]>;
    fetchHistorical(symbol: string, interval: string, limit: number, options?: { signal?: AbortSignal; offline?: boolean }): Promise<OHLCVData[]>;
    /**
     * Optional server-side disk cache hook. When set, the loader consults the
     * disk cache before rebuilding a synthetic pair in-memory. Returns null on
     * miss / invalid fingerprint / browser mode (no hook supplied). Async
     * because fingerprint computation may query the SQLite plugin.
     */
    computeSyntheticPairFingerprint?(args: SyntheticPairDiskCacheArgs): Promise<string | null>;
    loadCachedSyntheticPair?(args: SyntheticPairDiskCacheArgs, fingerprint?: string | null): Promise<{ bars: OHLCVData[] } | null>;
    /**
     * Optional server-side disk cache write hook. Called after a fresh
     * in-memory build succeeds. Returns true only when a file was written.
     */
    storeSyntheticPair?(args: SyntheticPairDiskCacheArgs, bars: OHLCVData[], fingerprint?: string | null): Promise<boolean>;
}

export function createBatchDatasetLoaderCore(options: BatchDatasetLoaderCoreOptions): BatchDatasetLoaderCore {
    const legCacheMaxEntries = Math.max(1, Math.floor(options.legCacheMaxEntries ?? 24));
    const pairCacheMaxEntries = Math.max(1, Math.floor(options.pairCacheMaxEntries ?? 16));
    const legCache = new SyntheticLegCache<OHLCVData[]>(legCacheMaxEntries);
    const pairCache = new SyntheticLegCache<OHLCVData[]>(pairCacheMaxEntries);
    const diskStats = { hits: 0, misses: 0, writes: 0 };

    async function load(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]> {
        const diagnostics = context?.diagnostics;
        const startedAt = performance.now();
        if (diagnostics) diagnostics.requests += 1;
        try {
            const synthParts = parseSyntheticPairToken(symbol);
            const effectiveInterval = resolveEffectiveIntervalForSynthetic(
                symbol,
                synthParts?.baseSymbol ?? null,
                synthParts?.quoteSymbol ?? null,
                interval,
            );
            if (synthParts) {
                return await loadSyntheticPair(
                    synthParts.baseSymbol,
                    synthParts.quoteSymbol,
                    effectiveInterval,
                    signal,
                    context,
                );
            }

            // Mine/Stability load each synthetic leg again as a standalone target.
            // Keep those targets on the same canonical source as the pair build:
            // ratio pairs use 30m legs and 1h/2h target series are aggregated from
            // those same 30m candles. Otherwise Batch succeeds while the miner
            // asks for absent 1h/2h CSVs and reports zero target assets.
            if (isIbkrSymbol(symbol) && (effectiveInterval === "1h" || effectiveInterval === "2h")) {
                const source = await options.fetchHistorical(symbol, "30m", DATA_CHART_TOTAL_LIMIT, {
                    signal,
                    offline: true,
                });
                if (signal?.aborted) return [];
                if (source.length > 0) {
                    return resampleOHLCV(source, effectiveInterval);
                }
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
        } finally {
            if (diagnostics) diagnostics.timingsMs.total += performance.now() - startedAt;
        }
    }

    async function loadSyntheticPair(
        baseSymbol: string,
        quoteSymbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]> {
        if (signal?.aborted) return [];
        const diagnostics = context?.diagnostics;
        if (diagnostics) diagnostics.syntheticPairRequests += 1;

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

        const activePairCache = context?.pairCache ?? pairCache;
        const cachedPair = activePairCache.get(pairKey);
        if (cachedPair) {
            if (diagnostics) diagnostics.pairCacheHits += 1;
            debugLogger.event(`${options.logPrefix}.synthetic_pair_cache_hit`, {
                syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
            });
            return cachedPair;
        }
        if (diagnostics) diagnostics.pairCacheMisses += 1;

        // Server-side disk cache (optional). Skipped in browser mode (no hook).
        // On hit, seed the in-memory pairCache so subsequent calls dedupe normally.
        const diskArgs: SyntheticPairDiskCacheArgs = {
            pairKey, syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
        };
        const bypassDiskCache = context?.preferInMemorySyntheticPairs === true;
        let fingerprint: string | null | undefined;
        if (bypassDiskCache) {
            if (diagnostics) diagnostics.diskCacheBypasses += 1;
        } else {
            const fingerprintStartedAt = performance.now();
            fingerprint = options.computeSyntheticPairFingerprint
                ? await options.computeSyntheticPairFingerprint(diskArgs)
                : undefined;
            if (diagnostics) diagnostics.timingsMs.fingerprint += performance.now() - fingerprintStartedAt;
            if (options.loadCachedSyntheticPair) {
                const diskLookupStartedAt = performance.now();
                try {
                    const cached = await options.loadCachedSyntheticPair(diskArgs, fingerprint);
                    if (cached) {
                        diskStats.hits += 1;
                        if (diagnostics) diagnostics.diskCacheHits += 1;
                        debugLogger.event(`${options.logPrefix}.synthetic_pair_disk_cache_hit`, {
                            syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
                        });
                        const diskPromise = Promise.resolve(cached.bars);
                        activePairCache.set(pairKey, diskPromise);
                        return await diskPromise;
                    }
                    diskStats.misses += 1;
                    if (diagnostics) diagnostics.diskCacheMisses += 1;
                } catch (error) {
                    debugLogger.warn(`${options.logPrefix}.synthetic_pair_disk_cache_read_failed`, {
                        syntheticSymbol, error: error instanceof Error ? error.message : String(error),
                    });
                    diskStats.misses += 1;
                    if (diagnostics) diagnostics.diskCacheMisses += 1;
                } finally {
                    if (diagnostics) diagnostics.timingsMs.diskLookup += performance.now() - diskLookupStartedAt;
                }
            }
        }

        const promise = (async (): Promise<OHLCVData[]> => {
            if (signal?.aborted) return [];
            const pairBuildStartedAt = performance.now();
            const result = await buildSyntheticPairFromLegs({
                baseSymbol,
                quoteSymbol,
                interval,
                targetBars: SYNTHETIC_TARGET_BARS,
                sourceBarsCap: DATA_CHART_TOTAL_LIMIT,
                // DataFetcher/CSV loaders already return canonical sorted,
                // deduplicated candles. Keep the expensive generic parser for
                // other callers, but use the normalized pair hot path here.
                assumeNormalizedLegs: true,
                fetchLeg: (legSymbol, legInterval, legBars) =>
                    getSourceSeries(legSymbol, legInterval, legBars, signal, context),
            });
            if (diagnostics) {
                diagnostics.pairBuilds += 1;
                diagnostics.timingsMs.pairBuild += performance.now() - pairBuildStartedAt;
            }
            if (signal?.aborted) return [];
            // Write to disk cache (fire-and-forget; failures logged, never thrown).
            // Done here inside the producer so the write happens once per true miss,
            // not on every consumer awaiting the same deduped promise.
            if (!bypassDiskCache && options.storeSyntheticPair && result.bars.length > 0) {
                const pairWriteStartedAt = performance.now();
                try {
                    if (await options.storeSyntheticPair(diskArgs, result.bars, fingerprint)) {
                        diskStats.writes += 1;
                    }
                } catch (error) {
                    debugLogger.warn(`${options.logPrefix}.synthetic_pair_disk_cache_write_failed`, {
                        syntheticSymbol, error: error instanceof Error ? error.message : String(error),
                    });
                }
                if (diagnostics) diagnostics.timingsMs.pairWrite += performance.now() - pairWriteStartedAt;
            }
            return result.bars;
        })();

        return cacheSuccessfulLoad(activePairCache, pairKey, promise, signal);
    }

    function getSourceSeries(
        sourceSymbol: string,
        sourceInterval: string,
        sourceBars: number,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]> {
        const legKey = buildLegCacheKey(sourceSymbol, sourceInterval, sourceBars);
        const activeLegCache = context?.legCache ?? legCache;
        const diagnostics = context?.diagnostics;
        const cached = activeLegCache.get(legKey);
        if (cached) {
            if (diagnostics) diagnostics.legCacheHits += 1;
            debugLogger.event(`${options.logPrefix}.synthetic_leg_cache_hit`, { sourceSymbol, sourceInterval, sourceBars });
            return cached;
        }
        if (diagnostics) diagnostics.legCacheMisses += 1;

        const markedLeg = isMarkedLocalStockSymbol(sourceSymbol);
        const minHealthyLegBars = Math.max(1_000, Math.floor(sourceBars * 0.25));
        const fetchLeg = (offline: boolean): Promise<OHLCVData[]> => {
            if (diagnostics) {
                diagnostics.sourceLoads += 1;
                diagnostics.sourceBarsRequested += sourceBars;
            }
            const sourceStartedAt = performance.now();
            return options.fetchHistorical(sourceSymbol, sourceInterval, sourceBars, {
                signal,
                ...(offline ? { offline: true } : {}),
            }).then((data) => {
                if (diagnostics) {
                    diagnostics.sourceBarsLoaded += data.length;
                    diagnostics.timingsMs.sourceLoads += performance.now() - sourceStartedAt;
                }
                return data;
            });
        };
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
        return cacheSuccessfulLoad(activeLegCache, legKey, promise, signal);
    }

    return {
        load,
        clearCaches() {
            legCache.clear();
            pairCache.clear();
            diskStats.hits = 0;
            diskStats.misses = 0;
            diskStats.writes = 0;
        },
        getCacheStats(): BatchDatasetCacheStats {
            return {
                leg: { hits: legCache.hitCount(), misses: legCache.missCount(), size: legCache.size, max: legCacheMaxEntries },
                pair: { hits: pairCache.hitCount(), misses: pairCache.missCount(), size: pairCache.size, max: pairCacheMaxEntries },
                disk: { ...diskStats },
            };
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
