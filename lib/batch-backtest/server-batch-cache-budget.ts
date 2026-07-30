import { totalmem } from "node:os";

const HIGH_MEMORY_THRESHOLD_BYTES = 48 * 1024 ** 3;

export interface ServerBatchCacheBudget {
    legCacheMaxEntries: number;
    pairCacheMaxEntries: number;
}

export function resolveServerBatchCacheBudget(
    totalMemoryBytes = totalmem(),
): ServerBatchCacheBudget {
    if (totalMemoryBytes >= HIGH_MEMORY_THRESHOLD_BYTES) {
        return {
            legCacheMaxEntries: 128,
            pairCacheMaxEntries: 32,
        };
    }
    return {
        legCacheMaxEntries: 24,
        pairCacheMaxEntries: 16,
    };
}
