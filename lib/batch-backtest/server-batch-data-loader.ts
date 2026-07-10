/**
 * Node-side dataset loader for server-side Batch Backtest.
 *
 * This wrapper supplies a Node-safe `DataFetcher` to the shared Batch loader
 * core. It must not import `dataManager` or browser-bound modules: anything
 * imported by the Vite plugin is bundled into the dev-server config path.
 */

import { DATA_CHART_TOTAL_LIMIT } from "../data/constants";
import { clearLocalDailyCsvCachesForSymbols, loadFreshIbkrCandlesFromPriceData } from "../candle-cache";
import { DataCache } from "../data/data-cache";
import { DataFetcher } from "../data/data-fetcher";
import { DataPersistence } from "../data/data-persistence";
import { DataProviderRouter } from "../data/data-provider-router";
import { isIbkrSymbol } from "../local-daily-datasets";
import type { OHLCVData } from "../types/strategies";
import { createBatchDatasetLoaderCore, type BatchDatasetCacheStats } from "./batch-dataset-loader-core";
import { loadCachedSyntheticPair, storeSyntheticPair } from "./synthetic-pair-disk-cache";

const providerRouter = new DataProviderRouter();
const dataCache = new DataCache();
const dataPersistence = new DataPersistence();
const emptyImportedData = new Map<string, OHLCVData[]>();

function createServerDataFetcher(): DataFetcher {
    return new DataFetcher(
        providerRouter,
        dataCache,
        dataPersistence,
        () => emptyImportedData,
        () => DATA_CHART_TOTAL_LIMIT,
        {},
    );
}

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
    return createServerDataFetcher().fetchHistoricalData(symbol, interval, limit, options);
}

const loader = createBatchDatasetLoaderCore({
    logPrefix: "batch.server",
    fetchDetached: (symbol, interval, options) =>
        createServerDataFetcher().fetchDataDetached(symbol, interval, options),
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
    dataCache.clear();
    // IBKR sync writes CSVs in the Vite server process, while the browser-side
    // sync completion hook can only invalidate the browser module cache. Clear
    // the Node-side parsed CSV cache before another Batch run so a fresh file
    // mtime cannot be paired with stale in-memory candles in the disk cache.
    clearLocalDailyCsvCachesForSymbols();
}

export function getServerBatchDatasetCacheStats(): BatchDatasetCacheStats {
    return loader.getCacheStats();
}
