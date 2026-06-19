export function mean(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle] ?? 0
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function sampleStdDev(values: readonly number[]): number {
    if (values.length < 2) {
        return 0;
    }

    const average = mean(values);
    const variance =
        values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
    return Math.sqrt(Math.max(0, variance));
}

export function percentile(values: readonly number[], p: number): number {
    if (values.length === 0) {
        return 0;
    }

    return percentileSorted([...values].sort((left, right) => left - right), p);
}

/**
 * Interpolated percentile over an already-sorted copy. Exposed so callers that
 * need multiple percentiles of the same distribution can sort once.
 */
export function percentileSorted(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
        return sorted[lower] ?? 0;
    }

    const lowerValue = sorted[lower] ?? 0;
    const upperValue = sorted[upper] ?? lowerValue;
    return lowerValue * (upper - index) + upperValue * (index - lower);
}

/**
 * Same contract as {@link median} but returns `null` for empty inputs so
 * callers that need to distinguish "no samples" from "zero" can do so without
 * keeping a private copy of the algorithm.
 */
export function medianOrNull(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    return median(values);
}

export interface SortedStats {
    sorted: number[];
    mean: number;
    median: number;
    stdDev: number;
    min: number;
    max: number;
    /** Interpolated percentile from the pre-sorted array (0-100). */
    percentile: (p: number) => number;
}

/**
 * Sorts the input once and derives mean, median, sample std dev, min/max, plus
 * a percentile accessor that reuses the sorted copy. Use this when several
 * distribution statistics for the same payload are needed - it avoids the
 * repeated O(n log n) sorts and multi-pass scans that calling {@link median},
 * {@link sampleStdDev}, and {@link percentile} independently would do.
 */
export function prepareSortedStats(values: readonly number[]): SortedStats {
    const n = values.length;
    const sorted = [...values].sort((left, right) => left - right);

    if (n === 0) {
        return {
            sorted,
            mean: 0,
            median: 0,
            stdDev: 0,
            min: 0,
            max: 0,
            percentile: () => 0,
        };
    }

    const sum = sorted.reduce((acc, value) => acc + value, 0);
    const meanValue = sum / n;
    let varianceSum = 0;
    for (let i = 0; i < n; i++) {
        const diff = sorted[i]! - meanValue;
        varianceSum += diff * diff;
    }
    const stdDevValue = n > 1 ? Math.sqrt(Math.max(0, varianceSum / (n - 1))) : 0;

    const middle = Math.floor(n / 2);
    const medianValue = n % 2 === 1
        ? sorted[middle] ?? 0
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;

    return {
        sorted,
        mean: meanValue,
        median: medianValue,
        stdDev: stdDevValue,
        min: sorted[0] ?? 0,
        max: sorted[n - 1] ?? 0,
        percentile: (p: number) => percentileSorted(sorted, p),
    };
}
