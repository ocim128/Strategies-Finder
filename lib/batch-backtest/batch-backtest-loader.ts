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
import {
    buildSyntheticPairFromLegs,
    deriveSyntheticSymbol,
    pickSourceInterval,
} from "../../scripts/lib/synthetic-pair";
import { SYNTHETIC_TARGET_BARS, DATA_CHART_TOTAL_LIMIT } from "../data/constants";
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
// prior truncated load (e.g. ~1000 bars from when the chart's visible-candles
// setting was small). A real full Binance dataset is ~65k bars; 10k sits well
// above any partial-cache pollution and well below a complete series, so the
// loader can confidently self-heal anything under it without re-fetching
// legitimate full datasets on every run. The runner's BATCH_MIN_USABLE_BARS
// (200) remains the absolute floor below which a dataset is rejected outright;
// these two constants intentionally differ because they answer different
// questions ("is the cache worth trusting?" vs "is the series usable at all?").
const STALE_FRAGMENT_BAR_THRESHOLD = 10_000;

/**
 * Loads one symbol's OHLCV series without touching the live chart.
 *
 * For a synthetic pair token (e.g. `ZEC+APT`), both legs are fetched via
 * `dataManager.fetchHistoricalData(...)` (deduped by the leg LRU) and run
 * through the same pick-source -> align -> aggregate pipeline Finder uses.
 *
 * Real symbols read warm-cache-first (`offline: true`). If the cache only
 * holds a stale fragment (below {@link STALE_FRAGMENT_BAR_THRESHOLD}), the
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
    if (synthParts) {
        return loadSyntheticPairForBatch(
            synthParts.baseSymbol,
            synthParts.quoteSymbol,
            interval,
            signal,
        );
    }

    const data = await dataManager.fetchDataDetached(symbol, interval, { signal, offline: true });
    if (signal?.aborted) return [];

    // Offline short-circuit can return a stale streaming-leftover fragment
    // (e.g. 16 bars) when the pair was never fully loaded on the chart. Fall
    // back to a full historical fetch: it goes through the paginated Binance
    // path, returns a complete series, and persists back to the same cache the
    // offline path reads, so subsequent runs are warm again. Mirrors why
    // Finder's synthetic-leg path intentionally avoids offline mode for cold
    // source intervals.
    if (data.length > 0 && data.length < STALE_FRAGMENT_BAR_THRESHOLD) {
        debugLogger.warn("batch.stale_fragment_refetch", {
            symbol, interval, cachedBars: data.length, threshold: STALE_FRAGMENT_BAR_THRESHOLD,
        });
        // Request a full backtest-sized series, NOT the chart's visible-candles
        // lookback. `getChartLookbackBars()` is a display preference (how many
        // candles the user wants visible on screen); it is unrelated to how
        // much history a backtest needs. When it is set low, fetching only that
        // many bars produces a uselessly short series for any pair whose local
        // cache does not already hold a deep history (matching the healthy
        // pairs' ~65k). DATA_CHART_TOTAL_LIMIT is the same target the chart
        // uses for a full load; Binance caps the response at ~65k.
        const targetBars = DATA_CHART_TOTAL_LIMIT;
        const refetched = await dataManager.fetchHistoricalData(symbol, interval, targetBars, { signal });
        if (signal?.aborted) return [];
        // If the network also returns a fragment (delisted symbol, provider
        // issue), prefer the larger of the two so the runner's minimum-bar
        // gate can make the final call with the best available information.
        return refetched.length >= data.length ? refetched : data;
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
    const source = pickSourceInterval(interval);
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
 * Fetch one synthetic source leg, deduped by `symbol|interval|bars`. Mirrors
 * Finder's `getSourceSeriesForSynthetic` (lib/finder-manager.ts:594): the
 * source fetch intentionally does NOT pass offline:true, because the derived
 * source interval (e.g. 5m for a 1h target) is one the user may never have
 * loaded directly, so an offline-only read would return stray bars and produce
 * a degenerate synthetic pair.
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

    const promise = dataManager.fetchHistoricalData(sourceSymbol, sourceInterval, sourceBars, { signal });
    legCache.set(legKey, promise);
    return promise;
}

// Test-only accessors. Production code should not call these; the caches are
// meant to persist for the page session, matching Finder's behavior.
export function __clearBatchDatasetCachesForTests(): void {
    legCache.clear();
    pairCache.clear();
}

export function __batchLegMissCountForTests(): number {
    return legCache.missCount();
}
