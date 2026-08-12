import { compareFinderResults, sortFinderResults } from "./finder-engine";
import type { FinderMetric, FinderResult } from "../types/finder";

export class FinderResultRanker {
    private readonly heap: FinderResult[] = [];
    private readonly maxSize: number;
    private readonly sortPriority: FinderMetric[];
    private readonly onEvict: ((evicted: FinderResult) => void) | undefined;

    constructor(
        maxSize: number,
        sortPriority: FinderMetric[],
        onEvict?: (evicted: FinderResult) => void,
    ) {
        this.maxSize = Math.max(1, maxSize);
        this.sortPriority = sortPriority;
        this.onEvict = onEvict;
    }

    /**
     * Offer a candidate. Returns true when the candidate is retained in the
     * bounded top-K set (so callers can attach per-candidate side data only
     * for retained candidates), false when it is rejected as worse-or-equal
     * to the current worst. The eviction hook fires for every candidate that
     * later leaves the retained set.
     */
    public offer(candidate: FinderResult): boolean {
        if (this.heap.length < this.maxSize) {
            this.heap.push(candidate);
            this.siftUpWorst(this.heap.length - 1);
            return true;
        }

        if (this.heap.length === 0) return false;
        if (compareFinderResults(candidate, this.heap[0], this.sortPriority) >= 0) {
            return false;
        }

        const evicted = this.heap[0];
        this.heap[0] = candidate;
        this.onEvict?.(evicted);
        this.siftDownWorst(0);
        return true;
    }

    public toSortedArray(limit: number): FinderResult[] {
        return sortFinderResults(this.heap, this.sortPriority)
            .slice(0, Math.max(1, limit));
    }

    private isWorse(a: FinderResult, b: FinderResult): boolean {
        return compareFinderResults(a, b, this.sortPriority) > 0;
    }

    private siftUpWorst(index: number): void {
        let idx = index;
        while (idx > 0) {
            const parent = Math.floor((idx - 1) / 2);
            if (!this.isWorse(this.heap[idx], this.heap[parent])) break;
            const tmp = this.heap[idx];
            this.heap[idx] = this.heap[parent];
            this.heap[parent] = tmp;
            idx = parent;
        }
    }

    private siftDownWorst(index: number): void {
        let idx = index;
        while (true) {
            const left = idx * 2 + 1;
            const right = left + 1;
            let worst = idx;

            if (left < this.heap.length && this.isWorse(this.heap[left], this.heap[worst])) {
                worst = left;
            }
            if (right < this.heap.length && this.isWorse(this.heap[right], this.heap[worst])) {
                worst = right;
            }
            if (worst === idx) break;

            const tmp = this.heap[idx];
            this.heap[idx] = this.heap[worst];
            this.heap[worst] = tmp;
            idx = worst;
        }
    }
}
