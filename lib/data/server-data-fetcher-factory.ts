/**
 * Node-safe factory for the long-lived `DataFetcher` shared by the server-side
 * Batch and Finder dataset loaders.
 *
 * Server-side import hygiene (AGENTS.md §"Server-Side Batch Backtest"): this is
 * a leaf module — it imports only `data-fetcher`, `data-cache`,
 * `data-persistence`, `data-provider-router`, and `data/constants`. It MUST NOT
 * import `data-manager`, `settings-manager`, `finder-manager`, or anything that
 * transitively reaches `constants.ts` or `chart-manager.ts` (both pull
 * `lightweight-charts`, which is ESM-only and breaks the cjs config bundle when
 * Vite bundles `vite.config.ts`).
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
 * the same sharing the duplicated code already had.
 */

import { DATA_CHART_TOTAL_LIMIT } from "./constants";
import { DataCache } from "./data-cache";
import { DataFetcher } from "./data-fetcher";
import { DataPersistence } from "./data-persistence";
import { DataProviderRouter } from "./data-provider-router";
import type { OHLCVData } from "../types/strategies";

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
