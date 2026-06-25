/**
 * Pure LRU cache for synthetic source legs and finished synthetic pairs.
 *
 * Extracted from `batch-backtest-loader.ts` so the dedup contract is unit-
 * testable without pulling in the runtime `data-manager` graph (which drags
 * `lightweight-charts` and is not ESM-resolvable under the esno test runner).
 *
 * The cache stores promises so concurrent in-flight requests for the same leg
 * share a single fetch (matching Finder's `syntheticSourceSeriesCache`). Failed
 * promises are evicted so the next request retries instead of surfacing a stale
 * rejection.
 *
 * Mirrors `lib/finder-manager.ts` `syntheticSourceSeriesCache` /
 * `universeDatasetCache`, but as a standalone class so Batch Backtest does not
 * reach into the FinderManager instance.
 */
export class SyntheticLegCache<T> {
    private readonly store = new Map<string, Promise<T>>();
    private readonly missCounts = new Map<string, number>();

    constructor(private readonly maxEntries: number) {}

    /**
     * Returns the cached promise for `key` if one exists (cache hit), touching
     * it as most-recently-used. Otherwise returns `undefined` (cache miss) and
     * the caller should produce a fresh promise and pass it to `set`.
     */
    get(key: string): Promise<T> | undefined {
        const value = this.store.get(key);
        if (value) {
            // Re-insert to mark most-recently-used (Map iterates in insertion order).
            this.store.delete(key);
            this.store.set(key, value);
        }
        return value;
    }

    /**
     * Stores a promise for `key`, evicting the least-recently-used entry if the
     * cache is over capacity. On rejection, the entry is removed so subsequent
     * calls retry. Records one miss per `set` (i.e. per actual producer call).
     */
    set(key: string, promise: Promise<T>): void {
        this.store.set(key, promise);
        this.missCounts.set(key, (this.missCounts.get(key) ?? 0) + 1);
        promise.catch(() => {
            if (this.store.get(key) === promise) {
                this.store.delete(key);
            }
        });
        this.evict();
    }

    /** Number of times a producer was actually invoked (cache misses). */
    missCount(): number {
        let total = 0;
        for (const count of this.missCounts.values()) total += count;
        return total;
    }

    clear(): void {
        this.store.clear();
        this.missCounts.clear();
    }

    get size(): number {
        return this.store.size;
    }

    private evict(): void {
        while (this.store.size > this.maxEntries) {
            const oldestKey = this.store.keys().next().value;
            if (!oldestKey) break;
            this.store.delete(oldestKey);
        }
    }
}

/** Build the cache key Finder uses for a synthetic source leg. */
export function buildLegCacheKey(
    sourceSymbol: string,
    sourceInterval: string,
    sourceBars: number,
): string {
    return `${sourceSymbol.trim().toUpperCase()}|${sourceInterval.trim().toLowerCase()}|${sourceBars}`;
}

/** Build the cache key Finder uses for a finished synthetic pair series. */
export function buildPairCacheKey(args: {
    syntheticSymbol: string;
    baseSymbol: string;
    quoteSymbol: string;
    interval: string;
    sourceInterval: string;
    sourceBars: number;
}): string {
    return [
        args.syntheticSymbol.trim().toUpperCase(),
        args.baseSymbol.trim().toUpperCase(),
        args.quoteSymbol.trim().toUpperCase(),
        args.interval.trim().toLowerCase(),
        args.sourceInterval.trim().toLowerCase(),
        args.sourceBars,
        "synthetic",
    ].join("|");
}
