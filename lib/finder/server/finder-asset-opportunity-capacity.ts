import { totalmem } from "node:os";

const MEMORY_BUDGET_FRACTION = 0.75;
// Includes the raw OHLCV dataset plus one prepared closed-candle reference
// array (up to ~0.8 MB at 100k bars) retained by batch holdout workers.
export const ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL = 10 * 1024 * 1024;

/** 75% of system RAM reserved for Finder datasets and prepared candle views. */
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

/** Capacity for the run-scoped plain-dataset LRU. */
export function resolveAssetOpportunityDatasetCacheCapacity(
    symbolCount: number,
    systemMemoryBytes: number = totalmem(),
): number {
    const memoryCeilingEntries = Math.floor(
        resolveAssetOpportunityMemoryBudgetBytes(systemMemoryBytes)
        / ASSET_OPPORTUNITY_BATCH_BYTES_PER_SYMBOL,
    );
    return Math.max(1, Math.min(Math.max(1, Math.floor(symbolCount)), memoryCeilingEntries));
}
