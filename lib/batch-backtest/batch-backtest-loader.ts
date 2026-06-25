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

/**
 * Loads one symbol's OHLCV series without touching the live chart.
 *
 * For a synthetic pair token (e.g. `ZEC+APT`), both legs are fetched via
 * `dataManager.fetchHistoricalData(...)` (deduped by the leg LRU) and run
 * through the same pick-source -> align -> aggregate pipeline Finder uses.
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
