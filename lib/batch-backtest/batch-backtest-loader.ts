/**
 * Browser-side detached dataset loader for Batch Backtest.
 *
 * The shared core owns synthetic-pair construction, stale-fragment repair, and
 * leg/pair LRU behavior. This wrapper supplies the browser `dataManager`
 * fetch functions so Batch can load datasets without touching the live chart.
 */

import { dataManager } from "../data-manager";
import type { OHLCVData } from "../types/strategies";
import { createBatchDatasetLoaderCore } from "./batch-dataset-loader-core";

const loader = createBatchDatasetLoaderCore({
    logPrefix: "batch",
    fetchDetached: (symbol, interval, options) => dataManager.fetchDataDetached(symbol, interval, options),
    fetchHistorical: (symbol, interval, limit, options) => dataManager.fetchHistoricalData(symbol, interval, limit, options),
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
