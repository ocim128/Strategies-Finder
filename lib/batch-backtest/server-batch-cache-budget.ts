import { totalmem } from "node:os";
import { isMainThread } from "node:worker_threads";

const HIGH_MEMORY_THRESHOLD_BYTES = 48 * 1024 ** 3;

export interface ServerBatchCacheBudget {
    legCacheMaxEntries: number;
    pairCacheMaxEntries: number;
}

export function resolveServerBatchCacheBudget(
    totalMemoryBytes = totalmem(),
    workerThread = !isMainThread,
): ServerBatchCacheBudget {
    // Machine RAM is shared by every isolate. Retaining 128 object-valued
    // seed legs in EACH worker scales the live GC graph with worker count.
    // A tile's complete working set fits in 24 legs on all hosts.
    if (workerThread) return { legCacheMaxEntries: 24, pairCacheMaxEntries: 16 };
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
