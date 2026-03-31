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

    const sorted = [...values].sort((left, right) => left - right);
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
