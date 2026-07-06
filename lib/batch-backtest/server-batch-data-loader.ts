/**
 * Node-side dataset loader for server-side Batch Backtest.
 *
 * This wrapper supplies a Node-safe `DataFetcher` to the shared Batch loader
 * core. It must not import `dataManager` or browser-bound modules: anything
 * imported by the Vite plugin is bundled into the dev-server config path.
 */

import { DATA_CHART_TOTAL_LIMIT } from "../data/constants";
import { DataCache } from "../data/data-cache";
import { DataFetcher } from "../data/data-fetcher";
import { DataPersistence } from "../data/data-persistence";
import { DataProviderRouter } from "../data/data-provider-router";
import type { OHLCVData } from "../types/strategies";
import { createBatchDatasetLoaderCore } from "./batch-dataset-loader-core";

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

const loader = createBatchDatasetLoaderCore({
    logPrefix: "batch.server",
    fetchDetached: (symbol, interval, options) =>
        createServerDataFetcher().fetchDataDetached(symbol, interval, options),
    fetchHistorical: (symbol, interval, limit, options) =>
        createServerDataFetcher().fetchHistoricalData(symbol, interval, limit, options),
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
}
