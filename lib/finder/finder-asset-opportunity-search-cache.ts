import type { Signal } from "../types/strategies";

/**
 * Worker-local cache for Asset Opportunity batch searches. A batch keeps the
 * same asset, strategy, and candidate parameter set while only the historical
 * prefix changes between holdouts, so the full-series signal pass can be
 * reused. The cache is intentionally bounded because signal arrays can be
 * larger than the scalar candidate results they replace.
 */
export interface AssetOpportunitySignalCache {
    get(key: string): Signal[] | undefined;
    set(key: string, signals: Signal[]): void;
}

export function createAssetOpportunitySignalCache(
    maxEntries = 8192,
): AssetOpportunitySignalCache {
    const entries = new Map<string, Signal[]>();
    const capacity = Math.max(1, Math.floor(maxEntries));
    return {
        get(key) {
            const signals = entries.get(key);
            if (!signals) return undefined;
            entries.delete(key);
            entries.set(key, signals);
            return signals;
        },
        set(key, signals) {
            entries.delete(key);
            entries.set(key, signals);
            while (entries.size > capacity) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;
                entries.delete(oldest);
            }
        },
    };
}
