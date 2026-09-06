import type { PairCandidate } from "./types";

const poolMemo = new WeakMap<object, unknown>();

/**
 * Caches a per-event pool computation on the pool array itself. The harness
 * passes the SAME pool instance to every score call within one event, so the
 * entry lives exactly one event and is garbage-collected after it. Scores
 * stay pure: identical pool contents always produce identical values.
 */
export function memoByPool<T>(pool: readonly PairCandidate[], compute: () => T): T {
    const cached = poolMemo.get(pool);
    if (cached !== undefined) return cached as T;
    const value = compute();
    poolMemo.set(pool, value);
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
