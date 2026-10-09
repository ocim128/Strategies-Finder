import type { OHLCVData } from "../types/index";

export type CacheEntryMetadata = {
    sanitizedFor?: string;
    contiguous?: boolean;
    contiguousFor?: string;
    lastBarTime?: number;
};

export type CacheEntry = CacheEntryMetadata & {
    candles: OHLCVData[];
    source: string;
};

export class DataCache {
    // Each entry holds a full candles array (up to ~100k bars, ~5-10 MB).
    // Capped by entry count rather than bytes; 64 keeps steady-state within
    // ~hundreds of MB while still covering typical symbol/interval churn.
    private readonly MAX_CACHE_ENTRIES = 64;
    /**
     * Production point budget bounding the total retained candle points across
     * all entries, so variable dataset sizes cannot turn the 64-entry cap into
     * unpredictable retained memory. Initial measurement candidate matching the
     * illustrative worst case this replaces (64 entries x 100k points = 6.4M
     * points retained at the entry cap); constructor overrides exist for tests
     * and future tuning without a new setting. Pass Infinity to disable the
     * point budget and restore entry-count-only retention.
     */
    static readonly DEFAULT_MAX_POINTS = 1_000_000;
    // Map iterates in insertion order; re-inserting a key (delete + set) moves
    // it to the most-recently-used position. This gives O(1) LRU eviction
    // without the prior O(MAX_CACHE_ENTRIES) timestamp scan on every overflow.
    private lruCache: Map<string, CacheEntry> = new Map();
    private cacheSyncAtByKey: Map<string, number> = new Map();
    // Accounted per-key lengths are kept independently of the cached array
    // references: stream updates mutate those arrays in place (push/splice)
    // without a full commit, so totals track the length at the last set,
    // update, or mutation notification rather than aliasing the live array.
    private accountedPointsByKey: Map<string, number> = new Map();
    private retainedPoints = 0;
    private evictionCount = 0;
    private readonly maxPoints: number;
    private readonly pointBudgetActive: boolean;

    constructor(options?: { maxPoints?: number }) {
        const maxPoints = options?.maxPoints ?? DataCache.DEFAULT_MAX_POINTS;
        this.pointBudgetActive = Number.isFinite(maxPoints) && maxPoints > 0;
        this.maxPoints = maxPoints;
    }

    get syncAtByKey(): Map<string, number> {
        return this.cacheSyncAtByKey;
    }

    get size(): number {
        return this.lruCache.size;
    }

    /** Total candle points currently retained across all entries. */
    get points(): number {
        return this.retainedPoints;
    }

    /** How many entries the dual budget has evicted since construction/reset. */
    get evictions(): number {
        return this.evictionCount;
    }

    /** The configured retained-points budget (Infinity when disabled). */
    get pointBudget(): number {
        return this.maxPoints;
    }

    get(key: string): CacheEntry | undefined {
        if (!this.lruCache.has(key)) return undefined;
        // Move to most-recently-used by reinserting at the end of iteration order.
        const entry = this.lruCache.get(key)!;
        this.lruCache.delete(key);
        this.lruCache.set(key, entry);
        return entry;
    }

    /** Retention check without bumping recency. */
    has(key: string): boolean {
        return this.lruCache.has(key);
    }

    set(cacheKey: string, candles: OHLCVData[], source: string, metadata: CacheEntryMetadata = {}): void {
        if (this.exceedsPointBudget(candles.length)) {
            // An unretainable dataset must never flush unrelated entries: a new
            // oversized key is not admitted at all, and an oversized
            // replacement discards only that entry. The caller keeps its array.
            // Metadata is cleaned either way — callers that stamp sync time
            // before admission (registerImportedData) must not leave an orphan
            // timestamp for a key the cache never retained.
            if (this.lruCache.has(cacheKey)) {
                this.removeEntry(cacheKey);
                this.evictionCount += 1;
            } else {
                this.cacheSyncAtByKey.delete(cacheKey);
                this.accountedPointsByKey.delete(cacheKey);
            }
            return;
        }
        // Ensure insertion order puts this key last (most-recently-used).
        if (this.lruCache.has(cacheKey)) {
            this.lruCache.delete(cacheKey);
        }
        this.lruCache.set(cacheKey, { candles, source, ...metadata });
        this.reaccountPoints(cacheKey, candles.length);
        this.enforceBudgets();
    }

    delete(key: string): boolean {
        return this.removeEntry(key);
    }

    invalidate(cacheKey: string): void {
        this.removeEntry(cacheKey);
    }

    clear(): void {
        this.lruCache.clear();
        this.cacheSyncAtByKey.clear();
        this.accountedPointsByKey.clear();
        this.retainedPoints = 0;
        this.evictionCount = 0;
    }

    updateCandles(cacheKey: string, candles: OHLCVData[], metadata: CacheEntryMetadata = {}): void {
        const entry = this.lruCache.get(cacheKey);
        if (!entry) return;
        if (this.exceedsPointBudget(candles.length)) {
            // The replacement alone exceeds the whole budget: drop this entry
            // instead of evicting unrelated entries to make room.
            this.removeEntry(cacheKey);
            this.evictionCount += 1;
            return;
        }
        entry.candles = candles;
        entry.sanitizedFor = metadata.sanitizedFor;
        entry.contiguous = metadata.contiguous;
        entry.contiguousFor = metadata.contiguousFor;
        entry.lastBarTime = metadata.lastBarTime;
        this.reaccountPoints(cacheKey, candles.length);
        this.enforceBudgets();
    }

    /**
     * Reaccount a key after an accepted in-place length change of its cached
     * array (stream push/splice mutate the shared reference without a full
     * commit). Reads the entry's current array length; metadata is untouched.
     * Growth beyond the whole budget discards that entry without flushing
     * unrelated entries.
     */
    notifyCandleArrayMutation(cacheKey: string): void {
        const entry = this.lruCache.get(cacheKey);
        if (!entry) return;
        if (this.exceedsPointBudget(entry.candles.length)) {
            this.removeEntry(cacheKey);
            this.evictionCount += 1;
            return;
        }
        this.reaccountPoints(cacheKey, entry.candles.length);
        this.enforceBudgets();
    }

    private exceedsPointBudget(points: number): boolean {
        return this.pointBudgetActive && points > this.maxPoints;
    }

    private reaccountPoints(cacheKey: string, nextLength: number): void {
        const previous = this.accountedPointsByKey.get(cacheKey) ?? 0;
        if (previous === nextLength) return;
        this.accountedPointsByKey.set(cacheKey, nextLength);
        this.retainedPoints += nextLength - previous;
    }

    private enforceBudgets(): void {
        while (
            (this.pointBudgetActive && this.retainedPoints > this.maxPoints)
            || this.lruCache.size > this.MAX_CACHE_ENTRIES
        ) {
            // Oldest key is the first in iteration order.
            const oldestKey = this.lruCache.keys().next().value;
            if (oldestKey === undefined) break;
            this.removeEntry(oldestKey);
            this.evictionCount += 1;
        }
    }

    private removeEntry(cacheKey: string): boolean {
        this.cacheSyncAtByKey.delete(cacheKey);
        const accounted = this.accountedPointsByKey.get(cacheKey);
        if (accounted !== undefined) {
            this.retainedPoints -= accounted;
            this.accountedPointsByKey.delete(cacheKey);
        }
        return this.lruCache.delete(cacheKey);
    }
}
