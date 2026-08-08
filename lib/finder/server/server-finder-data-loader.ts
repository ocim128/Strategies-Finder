/**
 * Node-side dataset loader for server-side Finder Symbol Universe.
 *
 * Thin wrapper that reuses {@link createBatchDatasetLoaderCore} — the same
 * shared core the Batch server loader uses — so the synthetic-pair pipeline,
 * `SyntheticLegCache` caps, `DATA_CHART_TOTAL_LIMIT` cap, stale-fragment
 * refetch, and offline-first gap-fill are identical to the Batch server path
 * BY CONSTRUCTION. This is the parity mitigation called out in AGENTS.md
 * §"Loader parity": the browser `loadUniverseDataset` path must not diverge
 * from the server path, and routing both through the same core is how the
 * Batch tab already achieved that.
 *
 * Server-side import hygiene (the documented bundle trap, AGENTS.md
 * §"Server-Side Batch Backtest"): this module imports ONLY leaf modules —
 * `data-fetcher`, `data-cache`, `data-persistence`, `data-provider-router`,
 * `data/constants`, and the synthetic-pair disk cache. It must NOT import from
 * `lib/finder-manager.ts`, `lib/data-manager.ts`, `lib/settings-manager.ts`,
 * or anything that transitively reaches `lib/constants.ts` or `lib/chart-manager.ts`
 * (both pull `lightweight-charts`, which is ESM-only and breaks the cjs config
 * bundle when Vite bundles `vite.config.ts`).
 */

import { clearLocalDailyCsvCachesForSymbols } from "../../candle-cache";
import type { OHLCVData } from "../../types/strategies";
import {
    createBatchDatasetLoaderCore,
    type BatchDatasetCacheStats,
} from "../../batch-backtest/batch-dataset-loader-core";
import {
    createSeedFingerprintMemo,
    loadCachedSyntheticPair,
    storeSyntheticPair,
} from "../../batch-backtest/synthetic-pair-disk-cache";
import { clearServerDataCache, createServerDataFetcher } from "../../data/server-data-fetcher-factory";
import { isIbkrSymbol } from "../../local-daily-datasets";
import { resolveServerBatchCacheBudget } from "../../batch-backtest/server-batch-cache-budget";
import { clearParsedIbkrCsvCache, loadFreshIbkrCandlesFromDisk } from "../../batch-backtest/server-ibkr-csv-loader";

// Reuse a single long-lived DataFetcher for the whole server loader (Finding 8).
const serverDataFetcher = createServerDataFetcher();
const fingerprintMemo = createSeedFingerprintMemo();
const cacheBudget = resolveServerBatchCacheBudget();

// The bounded-cache startup prune is triggered lazily by the disk-cache module
// on the first write (see `storeSyntheticPair` → `maybePruneAfterWrite`), NOT at
// import time. Running it at import time would prune the real cache directory
// as a side-effect of importing this module in tests.

const loader = createBatchDatasetLoaderCore({
    logPrefix: "finder.server",
    legCacheMaxEntries: cacheBudget.legCacheMaxEntries,
    pairCacheMaxEntries: cacheBudget.pairCacheMaxEntries,
    fetchDetached: (symbol, interval, options) =>
        serverDataFetcher.fetchDataDetached(symbol, interval, options),
    fetchHistorical: async (symbol, interval, limit, options) => {
        if (isIbkrSymbol(symbol)) {
            const candles = await loadFreshIbkrCandlesFromDisk(symbol, interval, options?.signal);
            if (!candles) return [];
            return candles.length > limit ? candles.slice(-limit) : candles;
        }
        return serverDataFetcher.fetchHistoricalData(symbol, interval, limit, options);
    },
    // Server-side disk cache. Same hooks as the Batch server loader so a
    // synthetic pair built once is reused across FINDER runs. NOTE: the Finder
    // and Batch loaders construct SEPARATE in-memory `loader` cores, so a pair
    // built by Batch is NOT reused by Finder (and vice versa) — only the
    // disk-backed cache (file fingerprints) is shared, on a cache miss the
    // in-memory core rebuilds. This is acceptable duplication; consolidating
    // the two loaders is a follow-up.
    computeSyntheticPairFingerprint: (args) =>
        fingerprintMemo.compute(args.baseSymbol, args.quoteSymbol, args.sourceInterval),
    loadCachedSyntheticPair: (args, fingerprint) => loadCachedSyntheticPair(args, fingerprint),
    storeSyntheticPair: (args, bars, fingerprint) => storeSyntheticPair(args, bars, fingerprint),
});

/**
 * Load a universe symbol dataset server-side. Mirrors the browser
 * `FinderManager.loadUniverseDataset` contract (returns the sliced/offline-
 * first OHLCV series, throws on a hard failure, respects the abort signal).
 *
 * NOTE: the browser `loadDataset` callback in
 * `FinderManager.runUniverseFinder` additionally applies
 * `sliceFinderDataWindow(data, options.dataSlice)` to the raw series and
 * records data-window stats. That slicing is a pure transform over the
 * already-loaded array; the SERVER caller (the future plugin) must apply the
 * same slice after this load so the browser-side data-window diagnostics
 * remain parity-identical. Keeping the slice at the call site (not in this
 * loader) preserves the loader's symmetry with the Batch loader, which does
 * not slice.
 */
export async function loadServerFinderDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    return loader.load(symbol, interval, signal);
}

export function clearServerFinderDatasetCaches(): void {
    loader.clearCaches();
    fingerprintMemo.clear();
    // Crypto/IBKR sync can update SQLite between Finder runs. The shared
    // DataCache otherwise keeps serving the pre-sync target timeframe even
    // after the synthetic leg/pair LRUs are cleared — a stale underlying
    // candle silently rebuilds a synthetic pair. Mirrors
    // `clearServerBatchDatasetCaches` so Finder/Batch invalidation clear the
    // same cache layers (audit Finding 1).
    clearServerDataCache();
    // IBKR sync writes CSVs in the Vite server process; clear the Node-side
    // parsed CSV caches before another Finder run so a fresh file mtime cannot
    // be paired with stale in-memory candles in the disk cache.
    clearLocalDailyCsvCachesForSymbols();
    clearParsedIbkrCsvCache();
}

export function getServerFinderDatasetCacheStats(): BatchDatasetCacheStats {
    return loader.getCacheStats();
}
