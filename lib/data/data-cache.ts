import type { OHLCVData } from "../types/index";

type CacheEntry = {
    candles: OHLCVData[];
    source: string;
};

export class DataCache {
    private readonly MAX_CACHE_ENTRIES = 256;
    // Map iterates in insertion order; re-inserting a key (delete + set) moves
    // it to the most-recently-used position. This gives O(1) LRU eviction
    // without the prior O(MAX_CACHE_ENTRIES) timestamp scan on every overflow.
    private lruCache: Map<string, CacheEntry> = new Map();
    private cacheSyncAtByKey: Map<string, number> = new Map();

    get syncAtByKey(): Map<string, number> {
        return this.cacheSyncAtByKey;
    }

    get size(): number {
        return this.lruCache.size;
    }

    get(key: string): CacheEntry | undefined {
        if (!this.lruCache.has(key)) return undefined;
        // Move to most-recently-used by reinserting at the end of iteration order.
        const entry = this.lruCache.get(key)!;
        this.lruCache.delete(key);
        this.lruCache.set(key, entry);
        return entry;
    }

    set(cacheKey: string, candles: OHLCVData[], source: string): void {
        // Ensure insertion order puts this key last (most-recently-used).
        if (this.lruCache.has(cacheKey)) {
            this.lruCache.delete(cacheKey);
        }
        this.lruCache.set(cacheKey, { candles, source });

        if (this.lruCache.size > this.MAX_CACHE_ENTRIES) {
            // Oldest key is the first in iteration order.
            const oldestKey = this.lruCache.keys().next().value;
            if (oldestKey !== undefined) {
                this.removeEntry(oldestKey);
            }
        }
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
    }

    updateCandles(cacheKey: string, candles: OHLCVData[]): void {
        const entry = this.lruCache.get(cacheKey);
        if (entry) {
            entry.candles = candles;
        }
    }

    private removeEntry(cacheKey: string): boolean {
        this.cacheSyncAtByKey.delete(cacheKey);
        return this.lruCache.delete(cacheKey);
    }
}
