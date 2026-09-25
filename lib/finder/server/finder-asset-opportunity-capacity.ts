import { totalmem } from "node:os";
import { ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES } from "../finder-asset-opportunity-search-cache";

const MEMORY_BUDGET_FRACTION = 0.75;
// Includes the raw OHLCV dataset plus one prepared closed-candle reference
// array (up to ~0.8 MB at 100k bars) retained by batch holdout workers.
export const ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL = 10 * 1024 * 1024;

/** 75% of system RAM available to Asset Opportunity worker state. */
export function resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes: number): number {
    return Math.max(
        1,
        Math.floor(
            (Number.isFinite(systemMemoryBytes) && systemMemoryBytes > 0
                ? systemMemoryBytes
                : 8 * 1024 * 1024 * 1024)
            * MEMORY_BUDGET_FRACTION,
        ),
    );
}

/** Capacity for the run-scoped plain-dataset LRU, leaving room for worker signals. */
export function resolveAssetOpportunityDatasetCacheCapacity(
    symbolCount: number,
    systemMemoryBytes: number = totalmem(),
): number {
    const datasetMemoryBudgetBytes = Math.max(
        1,
        resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes)
            - ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES,
    );
    const memoryCeilingEntries = Math.floor(
        datasetMemoryBudgetBytes / ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL,
    );
    return Math.max(1, Math.min(Math.max(1, Math.floor(symbolCount)), memoryCeilingEntries));
}
