/**
 * Node-side dataset loader for server-side Batch Backtest.
 *
 * This wrapper supplies a Node-safe `DataFetcher` to the shared Batch loader
 * core. It must not import `dataManager` or browser-bound modules: anything
 * imported by the Vite plugin is bundled into the dev-server config path.
 */

import { clearLocalDailyCsvCachesForSymbols, loadFreshIbkrCandlesFromPriceData } from "../candle-cache";
import { isIbkrSymbol } from "../local-daily-datasets";
import type { OHLCVData } from "../types/strategies";
import { createBatchDatasetLoaderCore, type BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import {
    loadCachedSyntheticPair,
    storeSyntheticPair,
} from "./synthetic-pair-disk-cache";
import { clearServerDataCache, createServerDataFetcher } from "../data/server-data-fetcher-factory";

// Reuse a single long-lived DataFetcher for the whole server loader (Finding 8).
const serverDataFetcher = createServerDataFetcher();

// The bounded-cache startup prune is triggered lazily by the disk-cache module
// on the first write (see `storeSyntheticPair` → `maybePruneAfterWrite`), NOT at
// import time. Running it at import time would prune the real cache directory
// as a side-effect of importing this module in tests.

async function fetchServerHistoricalData(
    symbol: string,
    interval: string,
    limit: number,
    options?: { signal?: AbortSignal; offline?: boolean },
): Promise<OHLCVData[]> {
    if (isIbkrSymbol(symbol)) {
        // Correctness boundary: every true leg-LRU miss must read the current
        // IBKR CSV. Large batches exceed the 24-leg LRU, so a once-per-run or
        // DataCache fallback can reintroduce a pre-sync leg after eviction.
        // Warm pair-disk hits never reach this path.
        const candles = await loadFreshIbkrCandlesFromPriceData(symbol, interval, options?.signal);
        if (!candles) return [];
        return candles.length > limit ? candles.slice(-limit) : candles;
    }
    return serverDataFetcher.fetchHistoricalData(symbol, interval, limit, options);
}

const loader = createBatchDatasetLoaderCore({
    logPrefix: "batch.server",
    fetchDetached: (symbol, interval, options) =>
        serverDataFetcher.fetchDataDetached(symbol, interval, options),
    fetchHistorical: fetchServerHistoricalData,
    // Server-side disk cache. File-backed legs use seed CSV mtimes; Binance
    // legs use SQLite series metadata as the fingerprint.
    loadCachedSyntheticPair: (args) => loadCachedSyntheticPair(args),
    storeSyntheticPair: (args, bars) => storeSyntheticPair(args, bars),
});

export async function loadServerBatchDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    return loader.load(symbol, interval, signal);
}

export function clearServerBatchDatasetCaches(): void {
    loader.clearCaches();
    // Crypto/IBKR sync can update SQLite between Batch runs. The shared
    // DataCache otherwise keeps serving the pre-sync target timeframe even
    // after the synthetic leg/pair LRUs are cleared, which makes Stability
    // report DATA_STALE against freshly stored candles.
    clearServerDataCache();
    // IBKR sync writes CSVs in the Vite server process, while the browser-side
    // sync completion hook can only invalidate the browser module cache. Clear
    // the Node-side parsed CSV cache before another Batch run so a fresh file
    // mtime cannot be paired with stale in-memory candles in the disk cache.
    clearLocalDailyCsvCachesForSymbols();
}

export function getServerBatchDatasetCacheStats(): BatchDatasetCacheStats {
    return loader.getCacheStats();
}
