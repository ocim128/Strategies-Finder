/**
 * Node-safe factory for the long-lived `DataFetcher` shared by the server-side
 * Batch and Finder dataset loaders, plus the disk-first data-source routing
 * both loaders delegate to.
 *
 * Server-side import hygiene (AGENTS.md §"Server-Side Batch Backtest"): this
 * module must stay Node-safe — it imports only `data-fetcher`, `data-cache`,
 * `data-persistence`, `data-provider-router`, `data/constants`, the CSV
 * leaf loaders, and `local-daily-datasets`. It MUST NOT import `data-manager`,
 * `settings-manager`, `finder-manager`, or anything that transitively reaches
 * `constants.ts` or `chart-manager.ts` (both pull `lightweight-charts`, which
 * is ESM-only and breaks the cjs config bundle when Vite bundles
 * `vite.config.ts`).
 *
 * Previously both server loaders duplicated this exact setup (`providerRouter`
 * + `dataCache` + `dataPersistence` + `emptyImportedData` + `createServerDataFetcher`)
 * and allocated a fresh `DataFetcher` per detached/historical call. The router,
 * cache, and persistence are shared module instances, so the per-call wrapper
 * added no isolation — only churn (thousands of short-lived allocations in a
 * large run). Reusing one `DataFetcher` per loader matches the normal
 * application path, which uses a single `DataFetcher` for the session.
 *
 * Returns ONE `DataFetcher` per call so the Finder and Batch loaders keep
 * independent fetcher identities (their in-memory LRUs are already separate
 * `createBatchDatasetLoaderCore` instances). The underlying provider router,
 * data cache, and persistence are shared module singletons by design — that is
 * the same sharing the duplicated code already had. The routing functions
 * below likewise take each loader's retained fetcher as their fallback
 * dependency so loader identities and cache ownership stay independent.
 */

import { DATA_CHART_TOTAL_LIMIT } from "./constants";
import { DataCache } from "./data-cache";
import { DataFetcher } from "./data-fetcher";
import { DataPersistence } from "./data-persistence";
import { DataProviderRouter } from "./data-provider-router";
import type { OHLCVData } from "../types/strategies";
import { isIbkrSymbol } from "../local-daily-datasets";
import { loadFreshIbkrCandlesFromDisk } from "../batch-backtest/server-ibkr-csv-loader";
import { loadFreshCryptoCandlesFromDisk } from "../batch-backtest/server-crypto-csv-loader";

const providerRouter = new DataProviderRouter();
const dataCache = new DataCache();
const dataPersistence = new DataPersistence();
const emptyImportedData = new Map<string, OHLCVData[]>();

/**
 * A long-lived `DataFetcher` backed by the shared server-side provider router,
 * data cache, and persistence. Callers should retain the returned instance for
 * the lifetime of their loader (one per loader); do NOT allocate per request.
 */
export function createServerDataFetcher(): DataFetcher {
    return new DataFetcher(
        providerRouter,
        dataCache,
        dataPersistence,
        () => emptyImportedData,
        () => DATA_CHART_TOTAL_LIMIT,
        {},
    );
}

/**
 * Clear the shared in-memory data cache. Crypto/IBKR sync can update SQLite
 * between runs; without this the cache keeps serving the pre-sync target
 * timeframe even after a loader's synthetic leg/pair LRUs are cleared, which
 * makes Stability report DATA_STALE against freshly stored candles.
 *
 * Exposed so loaders that need a hard reset (Batch) can clear the shared cache
 * alongside their own LRUs.
 */
export function clearServerDataCache(): void {
    dataCache.clear();
}

/**
 * Disk-first routing for a historical (limit-bounded) server dataset request,
 * shared verbatim by the Batch and Finder server loaders. `dataFetcher` is the
 * calling loader's retained fetcher and is only the fallback: IBKR symbols
 * read the current CSV (a null read is an empty result, never a provider call),
 * and offline non-IBKR requests try the synced crypto CSV first (a non-null
 * empty array is still a hit).
 */
export async function fetchServerHistoricalDataWithFetcher(
    dataFetcher: DataFetcher,
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
        // limitBars tail-materializes cached columnar seeds directly; the
        // slice below becomes a no-op but stays as the correctness backstop.
        const candles = await loadFreshIbkrCandlesFromDisk(symbol, interval, options?.signal, undefined, limit);
        if (!candles) return [];
        return candles.length > limit ? candles.slice(-limit) : candles;
    }
    if (options?.offline === true) {
        const cryptoCandles = await loadFreshCryptoCandlesFromDisk(symbol, interval, options.signal, undefined, limit);
        if (cryptoCandles) {
            return cryptoCandles.length > limit ? cryptoCandles.slice(-limit) : cryptoCandles;
        }
    }
    return dataFetcher.fetchHistoricalData(symbol, interval, limit, options);
}

/**
 * Disk-first routing for a detached server dataset request, shared verbatim by
 * the Batch and Finder server loaders. Unlike the historical routing, an IBKR
 * null read here continues to the fallback chain, and the crypto CSV read is
 * only attempted offline.
 */
export async function fetchServerDetachedDataWithFetcher(
    dataFetcher: DataFetcher,
    symbol: string,
    interval: string,
    options?: { signal?: AbortSignal; offline?: boolean },
): Promise<OHLCVData[]> {
    if (isIbkrSymbol(symbol)) {
        const ibkrCandles = await loadFreshIbkrCandlesFromDisk(symbol, interval, options?.signal);
        if (ibkrCandles) return ibkrCandles;
    }
    if (options?.offline === true) {
        const cryptoCandles = await loadFreshCryptoCandlesFromDisk(symbol, interval, options.signal);
        if (cryptoCandles) return cryptoCandles;
    }
    return dataFetcher.fetchDataDetached(symbol, interval, options);
}
