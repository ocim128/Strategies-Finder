import { debugLogger } from "../debug-logger";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import { isIbkrSymbol } from "../local-daily-datasets";
import {
    buildSyntheticPairFromLegs,
    deriveSyntheticSymbol,
    pickSourceInterval,
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
/**
 * After an aligned-metadata failure, skip re-attempts for this short, bounded
 * window so a permanently unavailable leg cannot turn every metadata consumer
 * into a full leg refetch, while a transient outage still recovers on the
 * next request after the window. Successful metadata loads clear the record.
 */
const ALIGNED_METADATA_RETRY_COOLDOWN_MS = 2_000;
/** Hard cap on cooldown bookkeeping; the map is cleared when exceeded. */
const ALIGNED_METADATA_COOLDOWN_MAX_KEYS = 1024;

export interface BatchDatasetLoaderCore {
    load(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<OHLCVData[]>;
    loadWithMetadata(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<BatchDatasetLoadResult>;
    clearCaches(): void;
    /** Snapshot of in-memory + disk cache counters for benchmark diagnostics. */
    getCacheStats(): BatchDatasetCacheStats;
}

/** Pair data plus optional loader-owned leg context for causal ledger features. */
export interface BatchDatasetLoadResult {
    data: OHLCVData[];
    /** Canonical symbols from the pair definition, not from a derived chart name. */
    baseSymbol?: string;
    quoteSymbol?: string;
    /** Closes aligned to `data`'s pair-bar timestamps. */
    baseCloses?: readonly (number | null)[];
    quoteCloses?: readonly (number | null)[];
}

export interface BatchDatasetCacheStats {
    leg: { hits: number; misses: number; size: number; max: number };
    pair: { hits: number; misses: number; size: number; max: number };
    disk: { hits: number; misses: number; writes: number };
}

/** Resampled time/close series extracted from one leg for close alignment. */
interface AlignedLegClosesSeries {
    times: number[];
    closes: number[];
}

/** Aligned closes for one pair dataset; both arrays always exist. */
interface AlignedPairCloses {
    baseCloses: readonly (number | null)[];
    quoteCloses: readonly (number | null)[];
}

/** Cancellation owner of an in-flight production: its AbortSignal, or null. */
type ProductionOwner = AbortSignal | null;

/**
 * Cached aligned closes with PROVENANCE: the exact pair dataset (by array
 * reference, held weakly so eviction never retains large datasets) they were
 * computed from. Retrieval validates this identity, so same-length data from
 * a different dataset is never served.
 */
export interface CachedPairMetadata extends AlignedPairCloses {
    datasetRef: WeakRef<OHLCVData[]>;
}

/** Bounded cache of aligned leg closes keyed by pair. */
type PairMetadataCache = SyntheticLegCache<CachedPairMetadata>;

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
    /** Shared resampled-series reuse: hits = alignments served, misses = series built. */
    alignedSeriesHits?: number;
    alignedSeriesMisses?: number;
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
     * Metadata paired with `pairCache`. Keeping aligned leg closes here avoids
     * resampling and remapping both legs on every metadata cache hit. Entries
     * carry the dataset reference they were computed from, so a same-length
     * dataset replacement is never served stale closes.
     */
    pairMetadataCache?: SyntheticLegCache<CachedPairMetadata>;
    /**
     * Optional bounded PLAIN-dataset cache for callers that reload the same
     * symbol|interval series repeatedly across iterations (Asset Opportunity
     * batch holdout sweeps). Consulted by the caller's load wrapper, NOT by
     * this loader core — synthetic legs/pairs keep flowing through their own
     * caches above, so do not store synthetic pairs here. Batch Backtest does
     * not set this field.
     */
    datasetCache?: SyntheticLegCache<OHLCVData[]>;
    /**
     * Prepared execution-aware candle arrays retained alongside batch
     * datasets across Asset Opportunity holdout iterations.
     */
    closedCandleCache?: SyntheticLegCache<{
        sourceDataRef: WeakRef<OHLCVData[]>;
        preparedData: OHLCVData[];
        asOfTimeSec: number;
        executionModel: string;
    }>;
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
     * Optional source-specific override for a present offline dataset that is
     * valid but naturally shorter than the generic deep-history threshold.
     * The callback is consulted only after an offline fetch returns data.
     */
    acceptOfflineThinData?(symbol: string, interval: string): boolean;
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
    const pairMetadataCache = new SyntheticLegCache<CachedPairMetadata>(pairCacheMaxEntries);
    // Bounded per-leg resampled time/close series shared across every pair
    // aligned at the same target interval. `alignLegCloses` only consumes
    // timestamps + closes, so resampling a leg once per (leg, interval) removes
    // the redundant OHLCV aggregation repeats when one symbol participates in
    // hundreds of pairs. Promises are stored (race-safe dedup like the leg
    // cache); failed source loads throw before a series is ever built, so the
    // cache cannot poison downstream alignment. Loader-internal like
    // `diskStats` — not part of the `getCacheStats()` wire contract.
    const alignedSeriesCache = new SyntheticLegCache<AlignedLegClosesSeries>(legCacheMaxEntries);
    const diskStats = { hits: 0, misses: 0, writes: 0 };
    // In-flight productions are scoped to their cancellation OWNER (the
    // AbortSignal of the caller that started them, or null for uncancellable
    // callers). Joining is only safe within one ownership group: a producer
    // must never let its own caller's abort decide another caller's result.
    // Entries are removed at settlement or invalidation, and a per-owner map
    // is removed when it empties, so bookkeeping cannot accumulate.
    // Bumped by clearCaches(). Productions capture the value at creation and
    // publish nothing (bars, metadata, or retry state) once it is stale, so a
    // request that was invalidated mid-flight can never overwrite newer cache
    // entries.
    let datasetGeneration = 0;
    const datasetIds = new WeakMap<readonly OHLCVData[], number>();
    let nextDatasetId = 0;

    function datasetId(data: readonly OHLCVData[]): number {
        let id = datasetIds.get(data);
        if (id === undefined) {
            id = ++nextDatasetId;
            datasetIds.set(data, id);
        }
        return id;
    }
    // Metadata retry cooldowns are scoped to the metadata-cache owner (loader
    // instance or run context): contexts with separate caches retry
    // independently, contexts intentionally sharing a cache share cooldowns.
    const metadataRetryCooldownsByCache = new WeakMap<PairMetadataCache, Map<string, number>>();

    function metadataCooldownMap(metadataCache: PairMetadataCache): Map<string, number> {
        let map = metadataRetryCooldownsByCache.get(metadataCache);
        if (!map) {
            map = new Map();
            metadataRetryCooldownsByCache.set(metadataCache, map);
        }
        return map;
    }

    function metadataCooldownActive(metadataCache: PairMetadataCache, pairKey: string): boolean {
        const failedAt = metadataCooldownMap(metadataCache).get(pairKey);
        return failedAt !== undefined && Date.now() - failedAt < ALIGNED_METADATA_RETRY_COOLDOWN_MS;
    }

    function armMetadataCooldown(metadataCache: PairMetadataCache, pairKey: string): void {
        const map = metadataCooldownMap(metadataCache);
        if (map.size >= ALIGNED_METADATA_COOLDOWN_MAX_KEYS) {
            map.clear();
        }
        map.set(pairKey, Date.now());
    }

    // In-flight productions are additionally scoped to the caller's ACTIVE
    // cache identity (loader instance or run context): independent contexts
    // with their own caches never join another context's pending work or
    // bypass their own valid cache hits, while contexts sharing a cache and
    // compatible cancellation ownership still deduplicate.
    const pendingPairProductionsByCache = new Map<SyntheticLegCache<OHLCVData[]>, Map<ProductionOwner, Map<string, Promise<BatchDatasetLoadResult>>>>();
    const pendingLegProductionsByCache = new Map<SyntheticLegCache<OHLCVData[]>, Map<ProductionOwner, Map<string, Promise<OHLCVData[]>>>>();
    const pendingMetadataByCache = new Map<PairMetadataCache, Map<ProductionOwner, Map<string, Promise<AlignedPairCloses>>>>();

    function pendingMapFor<T>(
        byCache: Map<unknown, Map<ProductionOwner, Map<string, Promise<T>>>>,
        cache: unknown,
        owner: ProductionOwner,
    ): Map<string, Promise<T>> {
        let byOwner = byCache.get(cache) as Map<ProductionOwner, Map<string, Promise<T>>> | undefined;
        if (!byOwner) {
            byOwner = new Map();
            byCache.set(cache, byOwner);
        }
        let map = byOwner.get(owner);
        if (!map) {
            map = new Map();
            byOwner.set(owner, map);
        }
        return map;
    }

    /**
     * Remove a pending entry only while it still points at the exact promise
     * being settled. A stale production's cleanup (after cache invalidation
     * or replacement) must never delete a newer same-key producer.
     */
    function dropPendingIf<T>(
        byCache: Map<unknown, Map<ProductionOwner, Map<string, Promise<T>>>>,
        cache: unknown,
        owner: ProductionOwner,
        key: string,
        promise: Promise<T>,
    ): void {
        const byOwner = byCache.get(cache) as Map<ProductionOwner, Map<string, Promise<T>>> | undefined;
        if (!byOwner) return;
        const map = byOwner.get(owner);
        if (!map || map.get(key) !== promise) return;
        map.delete(key);
        if (map.size === 0) {
            byOwner.delete(owner);
            if (byOwner.size === 0) byCache.delete(cache);
        }
    }

    /**
     * Aligned closes belong to a pair dataset only when their provenance is
     * that exact dataset (reference identity, held weakly). Bar-count
     * equality remains as an additional sanity check.
     */
    function metadataMatchesPairDataset(
        entry: CachedPairMetadata | undefined,
        pairBars: readonly OHLCVData[],
    ): boolean {
        return entry !== undefined
            && entry.datasetRef.deref() === pairBars
            && entry.baseCloses.length === pairBars.length
            && entry.quoteCloses.length === pairBars.length;
    }

    /**
     * Publish settled metadata carrying its dataset provenance. An existing
     * entry for the same dataset is kept; anything else (another dataset, or
     * a dataset that no longer exists) is REPLACED, never kept merely because
     * the key exists. Bars are published by the same settlement callback, so
     * the pair cache and metadata stay coherent per producer; the retrieval
     * identity check is the final correctness gate.
     */
    function publishSettledMetadata(
        metadataCache: PairMetadataCache,
        pairKey: string,
        closes: AlignedPairCloses,
        dataset: OHLCVData[],
    ): void {
        metadataCache.set(pairKey, Promise.resolve({
            baseCloses: closes.baseCloses,
            quoteCloses: closes.quoteCloses,
            datasetRef: new WeakRef(dataset),
        }));
    }

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
            if (synthParts) {
                return (await loadSyntheticPair(
                    synthParts.baseSymbol,
                    synthParts.quoteSymbol,
                    interval,
                    signal,
                    context,
                    false,
                )).data;
            }

            // OPEN_SCORE USD analysis loads each synthetic leg again as a standalone target.
            // Keep those targets on the same canonical source as the pair build:
            // ratio pairs use 30m legs and 1h/2h target series are aggregated from
            // those same 30m candles. Otherwise Batch succeeds while the miner
            // asks for absent 1h/2h CSVs and reports zero target assets.
            if (isIbkrSymbol(symbol) && (interval === "1h" || interval === "2h")) {
                const source = await options.fetchHistorical(symbol, "30m", DATA_CHART_TOTAL_LIMIT, {
                    signal,
                    offline: true,
                });
                if (signal?.aborted) return [];
                if (source.length > 0) {
                    return resampleOHLCV(source, interval);
                }
            }

            const data = await options.fetchDetached(symbol, interval, { signal, offline: true });
            if (signal?.aborted) return [];
            if (data.length === 0 && isIbkrSymbol(symbol)) {
                throw new Error(
                    `No IBKR local candles found for ${symbol} ${interval}. Batch uses the current chart interval; download that IBKR timeframe first or switch the chart interval to one that exists.`
                );
            }

            const staleFragmentThreshold = resolveStaleFragmentBarThreshold(interval);
            if (data.length > 0 && data.length < staleFragmentThreshold
                && !options.acceptOfflineThinData?.(symbol, interval)) {
                debugLogger.warn(`${options.logPrefix}.stale_fragment_refetch`, {
                    symbol, interval: interval, cachedBars: data.length, threshold: staleFragmentThreshold,
                });
                const targetBars = DATA_CHART_TOTAL_LIMIT;
                const offlineDeep = await options.fetchHistorical(symbol, interval, targetBars, {
                    signal,
                    offline: true,
                });
                if (signal?.aborted) return [];
                if (offlineDeep.length >= staleFragmentThreshold) {
                    return offlineDeep;
                }
                const refetched = await options.fetchHistorical(symbol, interval, targetBars, { signal });
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

    async function loadWithMetadata(
        symbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<BatchDatasetLoadResult> {
        const synthParts = parseSyntheticPairToken(symbol);
        if (!synthParts) return { data: await load(symbol, interval, signal, context) };
        return loadSyntheticPair(
            synthParts.baseSymbol,
            synthParts.quoteSymbol,
            interval,
            signal,
            context,
            true,
        );
    }

    async function loadSyntheticPair(
        baseSymbol: string,
        quoteSymbol: string,
        interval: string,
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
        includeMetadata = false,
    ): Promise<BatchDatasetLoadResult> {
        if (signal?.aborted) return { data: [] };
        const diagnostics = context?.diagnostics;
        if (diagnostics) diagnostics.syntheticPairRequests += 1;

        const syntheticSymbol = deriveSyntheticSymbol(baseSymbol, quoteSymbol);
        const available = resolveSyntheticAvailableIntervals(baseSymbol, quoteSymbol);
        const source = pickSourceInterval(interval, 12, available);
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
        const activePairMetadataCache = context?.pairMetadataCache ?? pairMetadataCache;
        const owner: ProductionOwner = signal ?? null;
        const generation = datasetGeneration;

        // Same-cache, same-ownership pending production: these callers share
        // the active pair cache AND a signal (or none), so joining preserves
        // single-producer behavior for one batch run without letting one
        // caller's abort decide another's result or bypassing another
        // context's own cache hit.
        const pendingProduction = pendingPairProductionsByCache.get(activePairCache)?.get(owner)?.get(pairKey);
        if (pendingProduction) {
            if (diagnostics) diagnostics.pairCacheHits += 1;
            debugLogger.event(`${options.logPrefix}.synthetic_pair_production_joined`, {
                syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
            });
            return consumePairProduction(pendingProduction, {
                activePairCache,
                activePairMetadataCache,
                pairKey,
                baseSymbol,
                quoteSymbol,
                interval,
                signal,
                context,
                includeMetadata,
            });
        }

        const cachedPair = activePairCache.get(pairKey);
        if (cachedPair) {
            if (diagnostics) diagnostics.pairCacheHits += 1;
            debugLogger.event(`${options.logPrefix}.synthetic_pair_cache_hit`, {
                syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
            });
            let data: OHLCVData[];
            try {
                data = await cachedPair;
            } catch (error) {
                if (signal?.aborted) return { data: [] };
                throw error;
            }
            if (signal?.aborted) return { data: [] };
            if (!includeMetadata) return { data, baseSymbol, quoteSymbol };
            return {
                data,
                baseSymbol,
                quoteSymbol,
                ...(await loadOrCacheAlignedLegCloses(
                    activePairCache,
                    activePairMetadataCache,
                    pairKey,
                    baseSymbol,
                    quoteSymbol,
                    interval,
                    data,
                    signal,
                    context,
                )),
            };
        }
        if (diagnostics) diagnostics.pairCacheMisses += 1;

        const diskArgs: SyntheticPairDiskCacheArgs = {
            pairKey, syntheticSymbol, baseSymbol, quoteSymbol, interval, sourceInterval, sourceBars,
        };
        const bypassDiskCache = context?.preferInMemorySyntheticPairs === true;
        if (bypassDiskCache && diagnostics) diagnostics.diskCacheBypasses += 1;

        // This caller's ownership group becomes the single producer for the
        // pair. The production is registered in the owner-scoped pending map
        // BEFORE its first asynchronous boundary, so overlapping same-owner
        // requests share one fingerprint computation, disk lookup, build, and
        // write. Settlement publishes results into the shared caches only
        // when the owning signal is still live and the caches have not been
        // invalidated meanwhile — a stale or cancelled production can never
        // overwrite a newer entry.
        const production = (async (): Promise<BatchDatasetLoadResult> => {
            let fingerprint: string | null | undefined;
            if (!bypassDiskCache) {
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
                            // Aligned closes are not part of the disk payload;
                            // includeMetadata callers load them below through
                            // the retryable metadata loader.
                            return { data: cached.bars, baseSymbol, quoteSymbol };
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

            if (signal?.aborted) return { data: [] };
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
            if (signal?.aborted) return { data: [] };
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
            const data = result.bars;
            if (!includeMetadata) return { data, baseSymbol, quoteSymbol };
            const [baseSeries, quoteSeries] = await Promise.all([
                getSharedAlignedSeries(baseSymbol, sourceInterval, sourceBars, interval, result.base, diagnostics),
                getSharedAlignedSeries(quoteSymbol, sourceInterval, sourceBars, interval, result.quote, diagnostics),
            ]);
            return {
                data,
                baseSymbol,
                quoteSymbol,
                baseCloses: alignLegClosesFromSeries(data, await baseSeries),
                quoteCloses: alignLegClosesFromSeries(data, await quoteSeries),
            };
        })();
        pendingMapFor(pendingPairProductionsByCache, activePairCache, owner).set(pairKey, production);
        void production.then(
            (result) => {
                dropPendingIf(pendingPairProductionsByCache, activePairCache, owner, pairKey, production);
                if (generation !== datasetGeneration) return; // caches invalidated: publish nothing
                if (signal?.aborted) return; // owning caller cancelled: publish nothing
                if (result.data.length === 0) return; // never cache an empty result
                // Bars and metadata are published by the SAME settlement
                // callback with the same dataset, so the pair cache and the
                // metadata cache stay coherent per producer.
                activePairCache.set(pairKey, Promise.resolve(result.data));
                if (includeMetadata
                    && result.baseCloses !== undefined && result.quoteCloses !== undefined) {
                    publishSettledMetadata(
                        activePairMetadataCache,
                        pairKey,
                        { baseCloses: result.baseCloses, quoteCloses: result.quoteCloses },
                        result.data,
                    );
                }
            },
            () => {
                // Rejections are retryable: drop the pending entry, publish nothing.
                dropPendingIf(pendingPairProductionsByCache, activePairCache, owner, pairKey, production);
            },
        );
        return consumePairProduction(production, {
            activePairCache,
            activePairMetadataCache,
            pairKey,
            baseSymbol,
            quoteSymbol,
            interval,
            signal,
            context,
            includeMetadata,
        });
    }

    /**
     * Await a pair production for ONE consumer. Cancellation stays
     * per-consumer: an aborted caller observes empty bars without evicting or
     * influencing the production other callers (same owner, already settled)
     * may still be served from the shared caches.
     */
    async function consumePairProduction(
        production: Promise<BatchDatasetLoadResult>,
        args: {
            activePairCache: SyntheticLegCache<OHLCVData[]>;
            activePairMetadataCache: PairMetadataCache;
            pairKey: string;
            baseSymbol: string;
            quoteSymbol: string;
            interval: string;
            signal?: AbortSignal;
            context?: BatchDatasetLoadContext;
            includeMetadata: boolean;
        },
    ): Promise<BatchDatasetLoadResult> {
        let built: BatchDatasetLoadResult;
        try {
            built = await production;
        } catch (error) {
            if (args.signal?.aborted) return { data: [] };
            throw error;
        }
        if (args.signal?.aborted) return { data: [] };
        const { data, baseSymbol, quoteSymbol } = built;
        if (!args.includeMetadata) return { data, baseSymbol, quoteSymbol };
        // Fresh builds carry closes computed from the exact dataset just
        // produced. A disk-hit result does not, so its metadata loads through
        // the retryable loader below. Either way the pair bars remain
        // available when the optional metadata fails.
        if (built.baseCloses !== undefined && built.quoteCloses !== undefined) {
            return { data, baseSymbol, quoteSymbol, baseCloses: built.baseCloses, quoteCloses: built.quoteCloses };
        }
        return {
            data,
            baseSymbol,
            quoteSymbol,
            ...(await loadOrCacheAlignedLegCloses(
                args.activePairCache,
                args.activePairMetadataCache,
                args.pairKey,
                args.baseSymbol,
                args.quoteSymbol,
                args.interval,
                data,
                args.signal,
                args.context,
            )),
        };
    }

    /**
     * Aligned closes for an already-available pair series (pair cache or disk
     * hit). A same-cache, same-owner in-flight attempt is joined so concurrent
     * consumers share one cold production; settled metadata is served only
     * when its dataset provenance is the exact pair dataset being served;
     * failures warn with the pair identity, arm a metadata-cache-scoped
     * cooldown, and leave nothing cached so a later request retries.
     * Legitimate "no aligned leg bar" outcomes are successes and stay cached
     * as nulls.
     */
    async function loadOrCacheAlignedLegCloses(
        activePairCache: SyntheticLegCache<OHLCVData[]>,
        metadataCache: PairMetadataCache,
        pairKey: string,
        baseSymbol: string,
        quoteSymbol: string,
        interval: string,
        pairBars: readonly OHLCVData[],
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
    ): Promise<Pick<BatchDatasetLoadResult, "baseCloses" | "quoteCloses">> {
        const owner: ProductionOwner = signal ?? null;
        const generation = datasetGeneration;

        const pendingKey = `${pairKey}|dataset:${datasetId(pairBars)}`;
        const pendingAttempt = pendingMetadataByCache.get(metadataCache)?.get(owner)?.get(pendingKey);
        if (pendingAttempt) {
            try {
                const closes = await pendingAttempt;
                return closes.baseCloses.length === pairBars.length && closes.quoteCloses.length === pairBars.length
                    ? closes : {};
            } catch {
                // The failed attempt already warned and armed its cooldown;
                // this consumer keeps its bars without closes.
                return {};
            }
        }

        const cachedMetadata = metadataCache.get(pairKey);
        if (cachedMetadata) {
            try {
                const entry = await cachedMetadata;
                if (metadataMatchesPairDataset(entry, pairBars)) {
                    return { baseCloses: entry.baseCloses, quoteCloses: entry.quoteCloses };
                }
                // Metadata computed against a different dataset (same length
                // or not): drop it and recompute for these bars.
                metadataCache.deleteIfValue(pairKey, cachedMetadata);
            } catch {
                // Defensive: a rejected entry is retryable and serves nothing.
                metadataCache.deleteIfValue(pairKey, cachedMetadata);
                return {};
            }
        }
        if (metadataCooldownActive(metadataCache, pairKey)) {
            // Recent failure for THIS cache owner: serve bars without closes
            // and without another leg refetch. Nothing is cached, so the next
            // request after the window retries the metadata.
            return {};
        }

        const attempt = loadAlignedLegCloses(
            metadataCache,
            pairKey,
            baseSymbol,
            quoteSymbol,
            interval,
            pairBars,
            signal,
            context,
            generation,
        );
        pendingMapFor(pendingMetadataByCache, metadataCache, owner).set(pendingKey, attempt);
        void attempt.then(
            async (closes) => {
                dropPendingIf(pendingMetadataByCache, metadataCache, owner, pendingKey, attempt);
                if (generation !== datasetGeneration) return; // caches invalidated
                if (signal?.aborted) return; // cancelled: publish nothing
                // If the served pair moved on to another dataset while this
                // attempt ran, the closes no longer describe the cached bars:
                // never publish stale provenance over a newer dataset.
                const storedPair = activePairCache.peek(pairKey);
                const currentBars = storedPair ? await storedPair.catch(() => undefined) : undefined;
                if (currentBars !== undefined && currentBars !== pairBars) return;
                publishSettledMetadata(metadataCache, pairKey, closes, pairBars as OHLCVData[]);
            },
            () => {
                dropPendingIf(pendingMetadataByCache, metadataCache, owner, pendingKey, attempt);
            },
        );
        try {
            return await attempt;
        } catch {
            return {};
        }
    }

    async function loadAlignedLegCloses(
        metadataCache: PairMetadataCache,
        pairKey: string,
        baseSymbol: string,
        quoteSymbol: string,
        interval: string,
        pairBars: readonly OHLCVData[],
        signal?: AbortSignal,
        context?: BatchDatasetLoadContext,
        generation = datasetGeneration,
    ): Promise<AlignedPairCloses> {
        try {
            const available = resolveSyntheticAvailableIntervals(baseSymbol, quoteSymbol);
            const source = pickSourceInterval(interval, 12, available);
            const sourceInterval = source?.sourceInterval ?? interval;
            const sourceBars = Math.min(SYNTHETIC_TARGET_BARS * (source?.ratio ?? 1), DATA_CHART_TOTAL_LIMIT);
            let [base, quote] = await Promise.all([
                getSourceSeries(baseSymbol, sourceInterval, sourceBars, signal, context),
                getSourceSeries(quoteSymbol, sourceInterval, sourceBars, signal, context),
            ]);
            let subdivided = source !== null;
            if (subdivided && (base.length === 0 || quote.length === 0)) {
                const fallback = await Promise.all([
                    getSourceSeries(baseSymbol, interval, SYNTHETIC_TARGET_BARS, signal, context),
                    getSourceSeries(quoteSymbol, interval, SYNTHETIC_TARGET_BARS, signal, context),
                ]);
                if (fallback[0].length > 0 && fallback[1].length > 0) {
                    base = fallback[0];
                    quote = fallback[1];
                    subdivided = false;
                }
            }
            if (signal?.aborted) {
                // Cancellation is not a metadata failure: reject without
                // warning or arming the retry cooldown.
                throw new Error(`Aligned metadata load aborted for ${baseSymbol}+${quoteSymbol} ${interval}.`);
            }
            // Align on the TARGET interval, matching the fresh-build path
            // below: the pair carries bucket-open timestamps, so the aligned
            // close must be the bucket's LAST source close (after resampling),
            // never the source close AT the bucket-open timestamp. Aligning
            // subdivided legs with `sourceInterval` used to pick the latter and
            // diverge from freshly built pairs (last-in-bucket vs
            // open-of-bucket prices for the same candle).
            const [baseSeries, quoteSeries] = await Promise.all([
                getSharedAlignedSeries(baseSymbol, sourceInterval, sourceBars, interval, base, context?.diagnostics),
                getSharedAlignedSeries(quoteSymbol, sourceInterval, sourceBars, interval, quote, context?.diagnostics),
            ]);
            const closes = {
                baseCloses: alignLegClosesFromSeries(pairBars, await baseSeries),
                quoteCloses: alignLegClosesFromSeries(pairBars, await quoteSeries),
            };
            metadataCooldownMap(metadataCache).delete(pairKey);
            return closes;
        } catch (error) {
            if (signal?.aborted) throw error;
            if (generation === datasetGeneration) {
                // A stale-generation failure belongs to caches that were
                // already invalidated: never warn or arm retry state against
                // a newer generation.
                debugLogger.warn(`${options.logPrefix}.synthetic_pair_aligned_metadata_failed`, {
                    syntheticSymbol: `${baseSymbol}+${quoteSymbol}`,
                    interval,
                    error: error instanceof Error ? error.message : String(error),
                });
                armMetadataCooldown(metadataCache, pairKey);
            }
            throw error;
        }
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
        // Same-owner pending leg fetch: joining keeps one fetch per ownership
        // group. Cross-owner callers start their own fetch instead, so an
        // aborted owner's legs can never resolve empty data into another
        // caller's build. The shared leg cache receives only settled,
        // uncancelled results.
        const owner: ProductionOwner = signal ?? null;
        const generation = datasetGeneration;
        const pending = pendingLegProductionsByCache.get(activeLegCache)?.get(owner)?.get(legKey);
        if (pending) {
            if (diagnostics) diagnostics.legCacheHits += 1;
            debugLogger.event(`${options.logPrefix}.synthetic_leg_production_joined`, { sourceSymbol, sourceInterval, sourceBars });
            return pending;
        }
        if (diagnostics) diagnostics.legCacheMisses += 1;

        const markedLeg = isIbkrSymbol(sourceSymbol);
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
                        || options.acceptOfflineThinData?.(sourceSymbol, sourceInterval) === true
                        ? data
                        : (debugLogger.warn(`${options.logPrefix}.synthetic_leg_offline_thin`, {
                                sourceSymbol,
                                sourceInterval,
                                returned: data.length,
                                expected: sourceBars,
                            }),
                            fetchLeg(false)),
                );
        pendingMapFor(pendingLegProductionsByCache, activeLegCache, owner).set(legKey, promise);
        void promise.then(
            (data) => {
                dropPendingIf(pendingLegProductionsByCache, activeLegCache, owner, legKey, promise);
                if (generation !== datasetGeneration) return; // caches invalidated
                if (signal?.aborted) return; // cancelled fetch: publish nothing
                activeLegCache.set(legKey, Promise.resolve(data));
            },
            () => {
                // Rejections are retryable: drop the pending entry, publish nothing.
                dropPendingIf(pendingLegProductionsByCache, activeLegCache, owner, legKey, promise);
            },
        );
        return promise;
    }

    /**
     * Resampled time/close series for one leg at one target interval, shared
     * across all pairs that align the same leg. Keyed by the leg-cache identity
     * plus target interval and source dataset identity. Coverage and last
     * close also guard the browser stream's in-place append/trim/tail updates;
     * historical corrections arrive as replacement datasets or invalidate
     * the loader. Identity bookkeeping holds source arrays only weakly.
     */
    function getSharedAlignedSeries(
        sourceSymbol: string,
        sourceInterval: string,
        sourceBars: number,
        targetInterval: string,
        legBars: readonly OHLCVData[],
        diagnostics?: BatchDatasetLoadDiagnostics,
    ): Promise<AlignedLegClosesSeries> {
        const coverageAnchor = legBars.length > 0
            ? `${legBars.length}:${legBars[0]!.time}:${legBars[legBars.length - 1]!.time}`
            : "empty";
        const seriesKey = `${buildLegCacheKey(sourceSymbol, sourceInterval, sourceBars)}|align:${targetInterval}|dataset:${datasetId(legBars)}|${coverageAnchor}|close:${legBars[legBars.length - 1]?.close}`;
        const cached = alignedSeriesCache.get(seriesKey);
        if (cached) {
            if (diagnostics) diagnostics.alignedSeriesHits = (diagnostics.alignedSeriesHits ?? 0) + 1;
            return cached;
        }
        if (diagnostics) diagnostics.alignedSeriesMisses = (diagnostics.alignedSeriesMisses ?? 0) + 1;
        const series = Promise.resolve(buildAlignedLegClosesSeries(legBars, targetInterval));
        alignedSeriesCache.set(seriesKey, series);
        return series;
    }

    return {
        load,
        loadWithMetadata,
        clearCaches() {
            legCache.clear();
            pairCache.clear();
            pairMetadataCache.clear();
            alignedSeriesCache.clear();
            // Invalidate in-flight productions: their captured generation no
            // longer matches, so their settlement publishes nothing into the
            // fresh caches. Identity-checked cleanup keeps any production a
            // NEWER request already registered.
            datasetGeneration += 1;
            pendingPairProductionsByCache.clear();
            pendingLegProductionsByCache.clear();
            pendingMetadataByCache.clear();
            metadataRetryCooldownsByCache.get(pairMetadataCache)?.clear();
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

/**
 * Resample one leg to the target interval and keep only the fields close
 * alignment consumes (timestamps + closes). Shared series caches build this
 * once per (leg, target interval) instead of once per pair.
 */
function buildAlignedLegClosesSeries(
    legBars: readonly OHLCVData[],
    interval: string,
): AlignedLegClosesSeries {
    const alignedLegBars = resampleOHLCV(legBars, interval);
    const times: number[] = [];
    const closes: number[] = [];
    for (let index = 0; index < alignedLegBars.length; index += 1) {
        const bar = alignedLegBars[index]!;
        if (typeof bar.time !== "number" || !Number.isFinite(bar.time)) continue;
        times.push(bar.time);
        closes.push(bar.close);
    }
    return { times, closes };
}

/**
 * Exact-port of the original `alignLegCloses` scan (two-pointer exact-match,
 * last-duplicate-time close, repeated-pair-timestamp memo) over a prebuilt
 * series. Non-finite leg timestamps are dropped at series-build time, matching
 * the original scan's skip behavior.
 */
function alignLegClosesFromSeries(
    pairBars: readonly OHLCVData[],
    series: AlignedLegClosesSeries,
): (number | null)[] {
    const result: (number | null)[] = new Array(pairBars.length);
    let legIndex = 0;
    let matchedTime: number | null = null;
    let matchedClose: number | null = null;

    for (let pairIndex = 0; pairIndex < pairBars.length; pairIndex += 1) {
        const pairTime = pairBars[pairIndex]!.time;
        const targetSec = typeof pairTime === "number" && Number.isFinite(pairTime)
            ? pairTime
            : null;
        if (targetSec === null) {
            result[pairIndex] = null;
            continue;
        }
        if (targetSec === matchedTime) {
            result[pairIndex] = matchedClose;
            continue;
        }

        while (legIndex < series.times.length && series.times[legIndex]! < targetSec) {
            legIndex += 1;
        }

        if (legIndex >= series.times.length || series.times[legIndex] !== targetSec) {
            matchedTime = null;
            matchedClose = null;
            result[pairIndex] = null;
            continue;
        }

        let lastMatchIndex = legIndex;
        let close = series.closes[legIndex]!;
        while (lastMatchIndex + 1 < series.times.length && series.times[lastMatchIndex + 1] === targetSec) {
            close = series.closes[lastMatchIndex + 1]!;
            lastMatchIndex += 1;
        }
        legIndex = lastMatchIndex + 1;
        matchedTime = targetSec;
        matchedClose = close;
        result[pairIndex] = close;
    }

    return result;
}

export function alignLegCloses(
    pairBars: readonly OHLCVData[],
    legBars: readonly OHLCVData[],
    interval: string,
): (number | null)[] {
    return alignLegClosesFromSeries(pairBars, buildAlignedLegClosesSeries(legBars, interval));
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
