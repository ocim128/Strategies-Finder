import type { OHLCVData } from "../../types/strategies";
import { computePriceActionBarMetrics } from "./price-action-frequency-core";

export type NullableSeries = (number | null)[];

export function nullsToZero(values: NullableSeries): number[] {
    return values.map((value) => value ?? 0);
}

export function buildLogReturnSeries(data: OHLCVData[]): number[] {
    const result = new Array(data.length).fill(0);
    for (let i = 1; i < data.length; i++) {
        const previous = data[i - 1].close;
        const current = data[i].close;
        result[i] = previous > 0 && current > 0 ? Math.log(current / previous) : 0;
    }
    return result;
}

export function buildRollingMinMax(
    values: number[],
    lookbackInput: number,
    includeCurrent = false
): { min: NullableSeries; max: NullableSeries } {
    const lookback = Math.max(1, Math.round(lookbackInput));
    const min: NullableSeries = new Array(values.length).fill(null);
    const max: NullableSeries = new Array(values.length).fill(null);

    for (let i = 0; i < values.length; i++) {
        const end = includeCurrent ? i : i - 1;
        const start = end - lookback + 1;
        if (start < 0 || end < 0) continue;

        let lo = Infinity;
        let hi = -Infinity;
        for (let j = start; j <= end; j++) {
            const value = values[j];
            if (value < lo) lo = value;
            if (value > hi) hi = value;
        }
        min[i] = lo;
        max[i] = hi;
    }

    return { min, max };
}

export function buildTrailingWindowSpan(values: number[], lookbackInput: number): NullableSeries {
    const range = buildRollingMinMax(values, lookbackInput, true);
    return values.map((_value, i) => {
        const lo = range.min[i];
        const hi = range.max[i];
        return lo === null || hi === null ? null : hi - lo;
    });
}

export function buildRollingKurtosis(values: number[], lookbackInput: number): NullableSeries {
    const lookback = Math.max(4, Math.round(lookbackInput));
    const result: NullableSeries = new Array(values.length).fill(null);

    for (let i = lookback - 1; i < values.length; i++) {
        let sum = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            sum += values[j];
        }
        const mean = sum / lookback;

        let m2 = 0;
        let m4 = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            const diff = values[j] - mean;
            const squared = diff * diff;
            m2 += squared;
            m4 += squared * squared;
        }
        m2 /= lookback;
        m4 /= lookback;
        if (m2 <= 0) continue;
        result[i] = m4 / (m2 * m2);
    }

    return result;
}

export function buildSweepReclaimSeries(data: OHLCVData[], lookbackInput: number): number[] {
    const lookback = Math.max(2, Math.round(lookbackInput));
    const lows = data.map((bar) => bar.low);
    const highs = data.map((bar) => bar.high);
    const trailingLows = buildRollingMinMax(lows, lookback, false).min;
    const trailingHighs = buildRollingMinMax(highs, lookback, false).max;
    const result = new Array(data.length).fill(0);

    for (let i = 0; i < data.length; i++) {
        const priorLow = trailingLows[i];
        const priorHigh = trailingHighs[i];
        if (priorLow === null || priorHigh === null) continue;

        const bar = data[i];
        const metrics = computePriceActionBarMetrics(bar);
        if (bar.low < priorLow && bar.close > priorLow) {
            result[i] = metrics.closeLocation;
        } else if (bar.high > priorHigh && bar.close < priorHigh) {
            result[i] = -(1 - metrics.closeLocation);
        }
    }

    return result;
}

export function buildVolumeWeightedEntropy(
    values: number[],
    weights: number[],
    lookbackInput: number,
    numBins = 5
): NullableSeries {
    const lookback = Math.max(3, Math.round(lookbackInput));
    const bins = Math.max(2, Math.round(numBins));
    const result: NullableSeries = new Array(values.length).fill(null);

    for (let i = lookback - 1; i < values.length; i++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = i - lookback + 1; j <= i; j++) {
            const value = values[j];
            if (value < lo) lo = value;
            if (value > hi) hi = value;
        }
        const span = hi - lo;
        if (span <= 0) {
            result[i] = 0;
            continue;
        }

        const counts = new Array(bins).fill(0);
        let totalWeight = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            const weight = Math.max(0, weights[j]);
            if (weight <= 0) continue;
            let bin = Math.floor(((values[j] - lo) / span) * bins);
            if (bin >= bins) bin = bins - 1;
            counts[bin] += weight;
            totalWeight += weight;
        }
        if (totalWeight <= 0) continue;

        let entropy = 0;
        for (let bin = 0; bin < bins; bin++) {
            if (counts[bin] <= 0) continue;
            const probability = counts[bin] / totalWeight;
            entropy -= probability * Math.log2(probability);
        }
        result[i] = entropy;
    }

    return result;
}
