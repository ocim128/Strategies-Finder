import { availableParallelism, totalmem } from "node:os";

const DEFAULT_MIN_LOAD_CONCURRENCY = 12;
const MAX_LOAD_CONCURRENCY = 64;
const HIGH_MEMORY_BYTES = 48 * 1024 ** 3;
const MEDIUM_MEMORY_BYTES = 24 * 1024 ** 3;

function positiveInteger(raw: unknown): number | null {
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
}

function detectedParallelism(): number {
    try {
        return Math.max(1, availableParallelism());
    } catch {
        return 8;
    }
}

/**
 * Rank Pairs Recent-200 is I/O-bound: measured classification time is
 * negligible while every loader slot waits on local/network data. Use two
 * async load slots per available logical core, bounded to avoid request storms.
 */
export function resolveRankPairsLoadConcurrency(
    totalPairs: number,
    explicit = positiveInteger(process.env.RANK_PAIRS_LOAD_CONCURRENCY),
    parallelism = detectedParallelism(),
): number {
    const requested = explicit
        ?? Math.max(DEFAULT_MIN_LOAD_CONCURRENCY, Math.floor(parallelism) * 2);
    const bounded = Math.max(1, Math.min(MAX_LOAD_CONCURRENCY, requested));
    return Math.max(1, Math.min(Math.max(1, Math.floor(totalPairs)), bounded));
}

/**
 * Recent legs contain only time/open/close arrays. A high-memory server can
 * retain the full asset universe and avoid re-reading legs after LRU churn.
 */
export function resolveRankPairsRecentLegCacheEntries(
    explicit = positiveInteger(process.env.RANK_PAIRS_RECENT_LEG_CACHE_ENTRIES),
    totalMemoryBytes = totalmem(),
): number {
    if (explicit !== null) return Math.max(128, Math.min(8_192, explicit));
    if (totalMemoryBytes >= HIGH_MEMORY_BYTES) return 2_048;
    if (totalMemoryBytes >= MEDIUM_MEMORY_BYTES) return 1_024;
    return 512;
}

export const __testInternals = {
    DEFAULT_MIN_LOAD_CONCURRENCY,
    MAX_LOAD_CONCURRENCY,
};
