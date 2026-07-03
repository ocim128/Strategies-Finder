/**
 * Standalone detached dataset loader for Batch Backtest.
 *
 * Mirrors what Finder's universe loader does (see
 * `lib/finder-manager.ts` private `loadUniverseDataset` /
 * `loadSyntheticPairForUniverse`), but as pure functions so Batch Backtest
 * does not need to reach into the FinderManager class.
 *
 * Real symbols go through `dataManager.fetchDataDetached(...)` with
 * `offline: true` (warm-cache-first). Synthetic `+` pairs reuse the shared
 * `buildSyntheticPairFromLegs(...)` pipeline from `scripts/lib/synthetic-pair`
 * so fill semantics stay identical to Finder / Data Mining / Worker.
 *
 * Two LRU caches (matching Finder's instance-level caches) dedup work across
 * pairs in one run:
 *   - `legCache`: synthetic source legs keyed by `symbol|interval|bars`, so a
 *     leg shared across many pairs (e.g. ZEC in a ZEC+* list) is fetched once.
 *   - `pairCache`: finished synthetic pair series keyed by symbol+legs+interval,
 *     so re-running the same list without reloading is near-instant.
 * Both live for the page session, like Finder's caches. The pure cache logic
 * lives in `synthetic-leg-cache.ts` so it can be unit-tested in isolation.
 */

import { dataManager } from "../data-manager";
import { debugLogger } from "../debug-logger";
import { parseSyntheticPairToken } from "../finder-manager";
import { isIbkrSymbol, isMarkedLocalStockSymbol } from "../local-daily-datasets";
import {
    buildSyntheticPairFromLegs,
    deriveSyntheticSymbol,
    pickSourceInterval,
    resolveEffectiveIntervalForSynthetic,
} from "../../scripts/lib/synthetic-pair";
import { SYNTHETIC_TARGET_BARS, DATA_CHART_TOTAL_LIMIT } from "../data/constants";
import { parseIntervalSeconds } from "../interval-utils";
import type { OHLCVData } from "../types/strategies";
import {
    SyntheticLegCache,
    buildLegCacheKey,
    buildPairCacheKey,
} from "./synthetic-leg-cache";

// Finder uses 64 for legs and 512 for finished datasets; Batch lists are
// smaller than a universe sweep, so 64 legs / 128 pairs is a comfortable bound.
const legCache = new SyntheticLegCache<OHLCVData[]>(64);
const pairCache = new SyntheticLegCache<OHLCVData[]>(128);

// A cached dataset below this many bars is almost certainly incomplete — either
// a stale streaming/gap-fill leftover (e.g. 16 bars over a single day) or a
// prior truncated load from when the chart's visible-candles setting was small.
// Use an interval-aware floor so newer listings with complete but shorter
// histories are not refetched on every page reload. The runner's 200-bar
// minimum remains the absolute usability floor.
const STALE_FRAGMENT_MAX_THRESHOLD = 10_000;
const STALE_FRAGMENT_MIN_THRESHOLD = 200;

/**
 * Loads one symbol's OHLCV series without touching the live chart.
 *
 * For a synthetic pair token (e.g. `ZEC+APT`), both legs are fetched via
 * `dataManager.fetchHistoricalData(...)` (deduped by the leg LRU) and run
 * through the same pick-source -> align -> aggregate pipeline Finder uses.
 *
 * Real symbols read warm-cache-first (`offline: true`). If the cache only
 * holds a stale fragment (below the interval-aware stale threshold), the
 * loader transparently falls back to a full `fetchHistoricalData` and repairs
 * the cache, so a user running Batch against a fresh symbol list does not have
 * to load each pair on the chart by hand.
 *
 * Returns `[]` for an aborted load or a synthetic with no usable bars; callers
 * surface that as a per-pair load failure rather than throwing.
 */
export async function loadBatchDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    const synthParts = parseSyntheticPairToken(symbol);
    // Same daily-only coercion as Finder's loadUniverseDataset: stock_market_data
    // has no intraday bars, so a finer interval would return empty.
    const effectiveInterval = resolveEffectiveIntervalForSynthetic(
        symbol,
        synthParts?.baseSymbol ?? null,
        synthParts?.quoteSymbol ?? null,
        interval,
    );
    if (synthParts) {
        return loadSyntheticPairForBatch(
            synthParts.baseSymbol,
            synthParts.quoteSymbol,
            effectiveInterval,
            signal,
        );
    }

    const data = await dataManager.fetchDataDetached(symbol, effectiveInterval, { signal, offline: true });
    if (signal?.aborted) return [];
    if (data.length === 0 && isIbkrSymbol(symbol)) {
        throw new Error(
            `No IBKR local candles found for ${symbol} ${effectiveInterval}. Batch uses the current chart interval; download that IBKR timeframe first or switch the chart interval to one that exists.`
        );
    }

    // Offline short-circuit can return a stale streaming-leftover fragment
    // (e.g. 16 bars) when the pair was never fully loaded on the chart. Fall
    // back to a full historical fetch: it goes through the paginated Binance
    // path, returns a complete series, and persists back to the same cache the
    // offline path reads, so subsequent runs are warm again. Mirrors why
    // Finder's synthetic-leg path intentionally avoids offline mode for cold
    // source intervals.
    const staleFragmentThreshold = resolveStaleFragmentBarThreshold(effectiveInterval);
    if (data.length > 0 && data.length < staleFragmentThreshold) {
        debugLogger.warn("batch.stale_fragment_refetch", {
            symbol, interval: effectiveInterval, cachedBars: data.length, threshold: staleFragmentThreshold,
        });
        // Offline-first repair: fetchDataDetached honors the chart's visible-candle
        // lookback, which can be much smaller than the SQLite store actually holds.
        // Try a deep offline read at the full backtest target before going remote.
        // On a cold page load this typically hits SQLite and avoids Binance entirely;
        // only if SQLite genuinely doesn't have the bars do we fall through to the
        // remote gap-fill below.
        const targetBars = DATA_CHART_TOTAL_LIMIT;
        const offlineDeep = await dataManager.fetchHistoricalData(symbol, effectiveInterval, targetBars, {
            signal,
            offline: true,
        });
        if (signal?.aborted) return [];
        if (offlineDeep.length >= staleFragmentThreshold) {
            return offlineDeep;
        }
        // SQLite genuinely shallow — go remote. The paginated Binance path returns
        // a complete series and persists back to the same cache the offline path
        // reads, so subsequent runs are warm again.
        const refetched = await dataManager.fetchHistoricalData(symbol, effectiveInterval, targetBars, { signal });
        if (signal?.aborted) return [];
        // If the network also returns a fragment (delisted symbol, provider
        // issue), prefer the larger of the available offline-deep / remote
        // results so the runner's minimum-bar gate makes the final call.
        return Math.max(refetched.length, offlineDeep.length) === refetched.length
            ? refetched
            : offlineDeep;
    }

    return data;
}

async function loadSyntheticPairForBatch(
    baseSymbol: string,
    quoteSymbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    if (signal?.aborted) return [];

    const syntheticSymbol = deriveSyntheticSymbol(baseSymbol, quoteSymbol);
    // Stock-market legs have no finer granularity than the target interval,
    // so skip the source subdivision for them (matches buildSyntheticPairFromLegs).
    const markedLeg = isMarkedLocalStockSymbol(baseSymbol) || isMarkedLocalStockSymbol(quoteSymbol);
    const source = markedLeg ? null : pickSourceInterval(interval);
    const sourceInterval = source?.sourceInterval ?? interval;
    // Same cap as Finder: derived source intervals often forces a remote
    // gap-fill, so capping at DATA_CHART_TOTAL_LIMIT keeps the paginated
    // fetch bounded.
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
        debugLogger.event("batch.synthetic_pair_cache_hit", {
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
            // Leg-level dedup: a list like ZEC+APT, ZEC+BNB, ... APT+ZEC shares
            // ZEC across every pair. Each unique leg is fetched at most once.
            fetchLeg: (legSymbol, legInterval, legBars) =>
                getSourceSeriesForBatch(legSymbol, legInterval, legBars, signal),
        });
        if (signal?.aborted) return [];
        return result.bars;
    })();

    pairCache.set(pairKey, promise);
    return promise;
}

/**
 * Fetch one synthetic source leg, deduped by `symbol|interval|bars`.
 *
 * Legs are persisted to SQLite/IDB after their first Binance fetch (see
 * data-fetcher.ts persistLocalCandles calls), so we read them offline-first —
 * matching Finder's `getSourceSeriesForSynthetic`. The hybrid fetcher falls
 * through to Binance on its own if no local data exists at all (true first-ever
 * fetch). As a safety net against a partial / interrupted prior persist, if the
 * offline result is degenerate (well below the requested sourceBars) we retry
 * once with the remote gap-fill path. Stock-market legs have no remote source
 * and stay unconditionally offline.
 */
function getSourceSeriesForBatch(
    sourceSymbol: string,
    sourceInterval: string,
    sourceBars: number,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    const legKey = buildLegCacheKey(sourceSymbol, sourceInterval, sourceBars);
    const cached = legCache.get(legKey);
    if (cached) {
        debugLogger.event("batch.synthetic_leg_cache_hit", { sourceSymbol, sourceInterval, sourceBars });
        return cached;
    }

    const markedLeg = isMarkedLocalStockSymbol(sourceSymbol);
    // 25% threshold: a healthy leg should be near the requested sourceBars;
    // anything dramatically smaller signals a partial cache or interrupted
    // prior persist, not a real short history.
    const minHealthyLegBars = Math.max(1_000, Math.floor(sourceBars * 0.25));
    const fetchLeg = (offline: boolean): Promise<OHLCVData[]> =>
        dataManager.fetchHistoricalData(sourceSymbol, sourceInterval, sourceBars, {
            signal,
            ...(offline ? { offline: true } : {}),
        });
    const promise = markedLeg
        ? fetchLeg(true)
        : fetchLeg(true).then((data) =>
                data.length >= minHealthyLegBars
                    ? data
                    : (debugLogger.warn("batch.synthetic_leg_offline_thin", {
                            sourceSymbol,
                            sourceInterval,
                            returned: data.length,
                            expected: sourceBars,
                        }),
                        fetchLeg(false)),
            );
    // SyntheticLegCache auto-evicts rejected promises (see its `set`), so no
    // manual cleanup is needed on failure — a retry produces a fresh producer.
    legCache.set(legKey, promise);
    return promise;
}

function resolveStaleFragmentBarThreshold(interval: string): number {
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

// Test-only accessors. Production code should not call these; the caches are
// meant to persist for the page session, matching Finder's behavior.
export function __clearBatchDatasetCachesForTests(): void {
    clearBatchDatasetCaches();
}

export function clearBatchDatasetCaches(): void {
    legCache.clear();
    pairCache.clear();
}

export function __batchLegMissCountForTests(): number {
    return legCache.missCount();
}
