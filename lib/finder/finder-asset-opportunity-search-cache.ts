import type { Signal } from "../types/strategies";

/**
 * Worker-local cache for Asset Opportunity batch searches. A batch keeps the
 * same asset, strategy, and candidate parameter set while only the historical
 * prefix changes between holdouts, so the full-series signal pass can be
 * reused. The cache is intentionally bounded because signal arrays can be
 * larger than the scalar candidate results they replace.
 */
export interface AssetOpportunitySignalCache {
    getWindow(key: string, startIndex: number, endIndex: number): Signal[] | undefined;
    set(key: string, signals: Signal[]): void;
}

export const ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ENTRIES = 8192;
export const ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES = 64 * 1024 * 1024;

// Signal object shapes and their referenced time values vary. This estimate
// intentionally budgets more than the array slot alone so dense caches cannot
// grow without bound between V8 heap measurements.
const ESTIMATED_SIGNAL_BYTES = 192;
const ESTIMATED_ARRAY_BYTES = 64;

interface CachedSignals {
    signals: Signal[];
    estimatedBytes: number;
    hasIntegerBarIndexes: boolean;
    orderedByBarIndex: boolean;
}

export function createAssetOpportunitySignalCache(
    maxEntries = ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ENTRIES,
    maxBytes = ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES,
): AssetOpportunitySignalCache {
    const entries = new Map<string, CachedSignals>();
    const capacity = Number.isFinite(maxEntries)
        ? Math.max(1, Math.floor(maxEntries))
        : ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ENTRIES;
    const byteCapacity = Number.isFinite(maxBytes)
        ? Math.max(0, Math.floor(maxBytes))
        : ASSET_OPPORTUNITY_SIGNAL_CACHE_MAX_ESTIMATED_BYTES;
    let estimatedBytes = 0;

    const touch = (key: string): CachedSignals | undefined => {
        const entry = entries.get(key);
        if (!entry) return undefined;
        entries.delete(key);
        entries.set(key, entry);
        return entry;
    };

    return {
        getWindow(key, startIndex, endIndex) {
            const entry = touch(key);
            if (!entry
                || !entry.hasIntegerBarIndexes
                || !Number.isInteger(startIndex)
                || !Number.isInteger(endIndex)
                || startIndex < 0
                || endIndex < startIndex) {
                return undefined;
            }

            const { signals } = entry;
            if (entry.orderedByBarIndex) {
                const start = lowerBound(signals, startIndex);
                const end = lowerBound(signals, endIndex);
                const windowSignals = new Array<Signal>(end - start);
                for (let index = start; index < end; index += 1) {
                    const signal = signals[index]!;
                    windowSignals[index - start] = {
                        ...signal,
                        barIndex: signal.barIndex! - startIndex,
                    };
                }
                return windowSignals;
            }

            // Unordered signals keep the old stable-order scan. Index and
            // ordering validation was already captured when the entry was set.
            const windowSignals: Signal[] = [];
            for (const signal of signals) {
                const barIndex = signal.barIndex!;
                if (barIndex >= startIndex && barIndex < endIndex) {
                    windowSignals.push({ ...signal, barIndex: barIndex - startIndex });
                }
            }
            return windowSignals;
        },
        set(key, signals) {
            const previous = entries.get(key);
            if (previous) {
                estimatedBytes -= previous.estimatedBytes;
                entries.delete(key);
            }

            const entryBytes = ESTIMATED_ARRAY_BYTES + signals.length * ESTIMATED_SIGNAL_BYTES;
            if (entryBytes > byteCapacity) return;

            let hasIntegerBarIndexes = true;
            let orderedByBarIndex = true;
            let previousBarIndex = Number.NEGATIVE_INFINITY;
            for (const signal of signals) {
                const barIndex = signal.barIndex;
                if (!Number.isInteger(barIndex)) {
                    hasIntegerBarIndexes = false;
                    orderedByBarIndex = false;
                    break;
                }
                if (barIndex! < previousBarIndex) orderedByBarIndex = false;
                previousBarIndex = barIndex!;
            }

            entries.set(key, {
                signals,
                estimatedBytes: entryBytes,
                hasIntegerBarIndexes,
                orderedByBarIndex,
            });
            estimatedBytes += entryBytes;
            while (entries.size > capacity || estimatedBytes > byteCapacity) {
                const oldest = entries.entries().next().value as [string, CachedSignals] | undefined;
                if (!oldest) break;
                entries.delete(oldest[0]);
                estimatedBytes -= oldest[1].estimatedBytes;
            }
        },
    };
}

function lowerBound(signals: readonly Signal[], target: number): number {
    let low = 0;
    let high = signals.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (signals[middle]!.barIndex! < target) low = middle + 1;
        else high = middle;
    }
    return low;
}
