import type { PairCandidate } from "./types";

const poolMemo = new WeakMap<object, Map<string, unknown>>();

/**
 * Caches per-event pool computations on the pool array itself, keyed by a
 * computation name so several different memoized values can coexist for one
 * event. The harness passes the SAME pool instance to every score call
 * within one event, so the entry lives exactly one event and is
 * garbage-collected after it. Scores stay pure: identical pool contents
 * always produce identical values.
 */
export function memoByPool<T>(pool: readonly PairCandidate[], key: string, compute: () => T): T {
    let slot = poolMemo.get(pool);
    if (!slot) {
        slot = new Map<string, unknown>();
        poolMemo.set(pool, slot);
    }
    if (slot.has(key)) return slot.get(key) as T;
    const value = compute();
    slot.set(key, value);
    return value;
}

export function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function medianValid(
    pool: readonly PairCandidate[],
    read: (candidate: PairCandidate) => number | null,
): number | null {
    return median(pool.map(read).filter((value): value is number => value !== null && Number.isFinite(value)));
}

export function directionAdjusted(candidate: PairCandidate, value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    if (candidate.direction === "long") return value;
    if (candidate.direction === "short") return -value;
    return null;
}

export function medianAbsoluteDeviation(values: readonly number[], center: number): number | null {
    if (values.length < 2) return null;
    return median(values.map((value) => Math.abs(value - center)));
}

export function hasCanonicalPairIdentity(candidate: PairCandidate): boolean {
    return candidate.pair.length > 0
        && candidate.baseSymbol.length > 0
        && candidate.quoteSymbol.length > 0
        && candidate.pair === `${candidate.baseSymbol}+${candidate.quoteSymbol}`;
}

interface SharedLegCounts {
    legCounts: ReadonlyMap<string, number>;
    pairCounts: ReadonlyMap<string, number>;
    canonical: boolean;
}

function unorderedLegPairKey(left: string, right: string): string {
    return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function sharedLegCounts(pool: readonly PairCandidate[]): SharedLegCounts {
    return memoByPool(pool, "shared-leg-counts", () => {
        const legCounts = new Map<string, number>();
        const pairCounts = new Map<string, number>();
        for (const entry of pool) {
            if (!hasCanonicalPairIdentity(entry)) {
                return { legCounts, pairCounts, canonical: false };
            }
            legCounts.set(entry.baseSymbol, (legCounts.get(entry.baseSymbol) ?? 0) + 1);
            if (entry.quoteSymbol !== entry.baseSymbol) {
                legCounts.set(entry.quoteSymbol, (legCounts.get(entry.quoteSymbol) ?? 0) + 1);
            }
            const pairKey = unorderedLegPairKey(entry.baseSymbol, entry.quoteSymbol);
            pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
        }
        return { legCounts, pairCounts, canonical: true };
    });
}

/**
 * Returns the fraction of other pool entries sharing either leg with the
 * candidate. The original definition is pairwise; the counts below compute
 * the same union in O(1) per candidate after one O(n) event pass.
 */
export function sharedLegOverlapFraction(
    candidate: PairCandidate,
    pool: readonly PairCandidate[],
): number | null {
    if (pool.length <= 1 || !hasCanonicalPairIdentity(candidate)) return null;
    const counts = sharedLegCounts(pool);
    if (!counts.canonical) return null;
    const baseCount = counts.legCounts.get(candidate.baseSymbol) ?? 0;
    const quoteCount = counts.legCounts.get(candidate.quoteSymbol) ?? 0;
    const sharedCount = candidate.baseSymbol === candidate.quoteSymbol
        ? baseCount - 1
        : baseCount
            + quoteCount
            - (counts.pairCounts.get(unorderedLegPairKey(candidate.baseSymbol, candidate.quoteSymbol)) ?? 0)
            - 1;
    const overlapFraction = sharedCount / (pool.length - 1);
    return Number.isFinite(overlapFraction) ? overlapFraction : null;
}
