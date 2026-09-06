/** Pure metrics shared by the legacy asset selector and pair selector. */

export interface SelectionMetric {
    count: number;
    mean: number | null;
    median: number | null;
}

export interface SelectionComparison {
    selected: SelectionMetric;
    benchmark: SelectionMetric;
    delta: SelectionMetric;
}

export function percentile(values: readonly number[], fraction: number): number {
    const position = (values.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return values[lower]!;
    return values[lower]! + (values[upper]! - values[lower]!) * (position - lower);
}

export function metric(values: readonly number[]): SelectionMetric {
    if (values.length === 0) return { count: 0, mean: null, median: null };
    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length >> 1;
    const median = sorted.length % 2 === 1
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return {
        count: values.length,
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        median,
    };
}

export function comparison(
    selected: readonly number[],
    benchmark: readonly number[],
): SelectionComparison {
    if (selected.length !== benchmark.length) throw new Error("comparison series have different lengths");
    const deltas = selected.map((value, index) => value - benchmark[index]!);
    return { selected: metric(selected), benchmark: metric(benchmark), delta: metric(deltas) };
}

export function formatNumber(value: number | null): string {
    return value === null ? "null" : value.toFixed(6);
}

/** Formats a fraction as a percentage, optionally with a leading plus sign. */
export function formatPercent(value: number | null, signed = false): string {
    if (value === null) return "n/a";
    return `${signed && value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

/** Formats a fraction as percentage points for pair-selection comparisons. */
export function formatPercentagePoints(value: number | null): string {
    if (value === null) return "n/a";
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}pp`;
}

export function formatScaleNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : formatNumber(value);
}
