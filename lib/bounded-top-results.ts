/** Retain at most limit values. compare uses Array.sort's best-first order. */
export class BoundedTopResults<T> {
    private readonly heap: T[] = [];

    constructor(private readonly limit: number, private readonly compare: (a: T, b: T) => number) {}

    get size(): number { return this.heap.length; }

    offer(value: T): void {
        if (this.heap.length < this.limit) {
            this.heap.push(value);
            let index = this.heap.length - 1;
            while (index > 0) {
                const parent = (index - 1) >>> 1;
                if (!(this.compare(this.heap[index], this.heap[parent]) > 0)) break;
                [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
                index = parent;
            }
            return;
        }
        if (this.limit <= 0 || !(this.compare(value, this.heap[0]) < 0)) return;
        this.heap[0] = value;
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let worst = index;
            if (left < this.heap.length && this.compare(this.heap[left], this.heap[worst]) > 0) worst = left;
            if (right < this.heap.length && this.compare(this.heap[right], this.heap[worst]) > 0) worst = right;
            if (worst === index) break;
            [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]];
            index = worst;
        }
    }

    toSortedArray(): T[] { return [...this.heap].sort(this.compare); }
}
