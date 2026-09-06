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
