import type { OHLCVData } from "../types/index";

type CacheEntry = {
    candles: OHLCVData[];
    lastAccessedAt: number;
    source: string;
};

export class DataCache {
    private readonly MAX_CACHE_ENTRIES = 15;
    private lruCache: Map<string, CacheEntry> = new Map();
    private cacheSyncAtByKey: Map<string, number> = new Map();

    get syncAtByKey(): Map<string, number> {
        return this.cacheSyncAtByKey;
    }

    get size(): number {
        return this.lruCache.size;
    }

    get(key: string): CacheEntry | undefined {
        const entry = this.lruCache.get(key);
        if (entry) {
            entry.lastAccessedAt = Date.now();
        }
        return entry;
    }

    set(cacheKey: string, candles: OHLCVData[], source: string): void {
        this.lruCache.set(cacheKey, {
            candles,
            lastAccessedAt: Date.now(),
            source
        });

        if (this.lruCache.size > this.MAX_CACHE_ENTRIES) {
            let oldestKey: string | null = null;
            let oldestAccess = Infinity;

            for (const [key, entry] of this.lruCache.entries()) {
                if (entry.lastAccessedAt < oldestAccess) {
                    oldestAccess = entry.lastAccessedAt;
                    oldestKey = key;
                }
            }

            if (oldestKey) {
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
