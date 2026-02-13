import { compareFinderResults } from "./finder-engine";
import type { FinderMetric, FinderResult } from "../types/finder";

export class FinderResultRanker {
    private readonly heap: FinderResult[] = [];
    private readonly maxSize: number;
    private readonly sortPriority: FinderMetric[];

    constructor(maxSize: number, sortPriority: FinderMetric[]) {
        this.maxSize = Math.max(1, maxSize);
        this.sortPriority = sortPriority;
    }

    public offer(candidate: FinderResult): void {
        if (this.heap.length < this.maxSize) {
            this.heap.push(candidate);
            this.siftUpWorst(this.heap.length - 1);
            return;
        }

        if (this.heap.length === 0) return;
        if (compareFinderResults(candidate, this.heap[0], this.sortPriority) >= 0) {
            return;
        }

        this.heap[0] = candidate;
        this.siftDownWorst(0);
    }

    public toSortedArray(limit: number): FinderResult[] {
        return [...this.heap]
            .sort((a, b) => compareFinderResults(a, b, this.sortPriority))
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
            [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
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

            [this.heap[idx], this.heap[worst]] = [this.heap[worst], this.heap[idx]];
            idx = worst;
        }
    }
}
