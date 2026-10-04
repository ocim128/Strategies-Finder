/** Parsed column retention, bounded by both candle points and entry count.
 * Callers touch recency with delete + set; returned candles are independent.
 */
export class PointBoundedParsedCache<T extends { columns: { time: { readonly length: number } } }> extends Map<string, T> {
    private retainedPoints = 0;
    evictions = 0;

    constructor(private readonly maxPoints: number, private readonly maxEntries = Infinity) { super(); }

    get points(): number { return this.retainedPoints; }

    override delete(key: string): boolean {
        const previous = this.get(key);
        if (!previous) return false;
        this.retainedPoints -= previous.columns.time.length;
        return super.delete(key);
    }

    override set(key: string, value: T): this {
        this.delete(key);
        super.set(key, value);
        this.retainedPoints += value.columns.time.length;
        while (this.points > this.maxPoints || this.size > this.maxEntries) {
            this.delete(this.keys().next().value!);
            this.evictions++;
        }
        return this;
    }

    override clear(): void {
        super.clear();
        this.retainedPoints = 0;
        this.evictions = 0;
    }
}
