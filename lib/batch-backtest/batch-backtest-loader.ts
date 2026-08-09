/**
 * Browser-side detached dataset loader for Batch Backtest.
 *
 * The shared core owns synthetic-pair construction, stale-fragment repair, and
 * leg/pair LRU behavior. This wrapper supplies the browser `dataManager`
 * fetch functions so Batch can load datasets without touching the live chart.
 */

import { loadSeedCandlesFromPriceData } from "../candle-cache";
import { dataManager } from "../data-manager";
import { isIbkrSymbol } from "../local-daily-datasets";
import type { OHLCVData } from "../types/strategies";
import { createBatchDatasetLoaderCore, type BatchDatasetCacheStats } from "./batch-dataset-loader-core";

const loader = createBatchDatasetLoaderCore({
    logPrefix: "batch",
    fetchDetached: (symbol, interval, options) => dataManager.fetchDataDetached(symbol, interval, options),
    fetchHistorical: async (symbol, interval, limit, options) => {
        if (isIbkrSymbol(symbol)) {
            // IBKR synthetic pairs must use the authoritative local CSV seed
            // (4h pairs resolve to their 30m seed interval). Avoid reading
            // SQLite and IndexedDB for the same leg before reaching that CSV.
            const seed = await loadSeedCandlesFromPriceData(symbol, interval, options?.signal, "ibkr-local");
            if (seed && seed.length > 0) {
                return seed.length > limit ? seed.slice(-limit) : seed;
            }
        }
        return dataManager.fetchHistoricalData(symbol, interval, limit, options);
    },
});

export async function loadBatchDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
): Promise<OHLCVData[]> {
    return loader.load(symbol, interval, signal);
}

export function __clearBatchDatasetCachesForTests(): void {
    clearBatchDatasetCaches();
}

export function clearBatchDatasetCaches(): void {
    loader.clearCaches();
}

/** Snapshot of in-memory + disk cache counters; disk counters stay 0 in browser mode. */
export function getBatchDatasetCacheStats(): BatchDatasetCacheStats {
    return loader.getCacheStats();
}
