import type { PairFeatureSnapshotBar } from "../types";

export function finitePositive(value: number | undefined): boolean {
    return value !== undefined && Number.isFinite(value) && value > 0;
}

export function populationMean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
}

export function populationVariance(values: readonly number[], mean = populationMean(values)): number {
    if (values.length === 0) return 0;
    let total = 0;
    for (const value of values) {
        const delta = value - mean;
        total += delta * delta;
    }
    return total / values.length;
}

export function populationStd(values: readonly number[]): number {
    return Math.sqrt(populationVariance(values));
}

export function median(values: readonly number[]): number {
    const ordered = [...values].sort((left, right) => left - right);
    if (ordered.length === 0) return 0;
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1
        ? ordered[middle]!
        : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function precedingCloses(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    count: number,
): { values: number[]; observations: number; complete: boolean } {
    const values: number[] = [];
    let observations = 0;
    let complete = true;
    for (let index = signalBarIndex - count; index < signalBarIndex; index += 1) {
        const close = bars[index]?.[4];
        if (finitePositive(close)) {
            values.push(close);
            observations += 1;
        } else {
            complete = false;
        }
    }
    return { values, observations, complete };
}

export function precedingLogReturns(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    intervals: number,
): { values: number[]; observations: number; complete: boolean } {
    const closes = precedingCloses(bars, signalBarIndex, intervals + 1);
    const values: number[] = [];
    for (let index = 1; index < closes.values.length; index += 1) {
        values.push(Math.log(closes.values[index]!) - Math.log(closes.values[index - 1]!));
    }
    return {
        values,
        observations: closes.observations,
        complete: closes.complete && closes.values.length === intervals + 1,
    };
}

export function simpleRegression(
    x: readonly number[],
    y: readonly number[],
): { slope: number; rSquared: number } | null {
    if (x.length !== y.length || x.length < 2) return null;
    const xMean = populationMean(x);
    const yMean = populationMean(y);
    let xx = 0;
    let xy = 0;
    for (let index = 0; index < x.length; index += 1) {
        const dx = x[index]! - xMean;
        xx += dx * dx;
        xy += dx * (y[index]! - yMean);
    }
    if (xx === 0) return null;
    const slope = xy / xx;
    const intercept = yMean - slope * xMean;
    let residual = 0;
    let total = 0;
    for (let index = 0; index < y.length; index += 1) {
        const error = y[index]! - (intercept + slope * x[index]!);
        residual += error * error;
        const deviation = y[index]! - yMean;
        total += deviation * deviation;
    }
    if (total === 0) return null;
    return { slope, rSquared: 1 - residual / total };
}

export function autocorrelation(values: readonly number[], lag: number): number | null {
    if (values.length <= lag) return null;
    const mean = populationMean(values);
    let denominator = 0;
    for (const value of values) {
        const delta = value - mean;
        denominator += delta * delta;
    }
    if (denominator === 0) return null;
    let numerator = 0;
    for (let index = lag; index < values.length; index += 1) {
        numerator += (values[index]! - mean) * (values[index - lag]! - mean);
    }
    return numerator / denominator;
}

export function varianceRatio(values: readonly number[], horizon: number): number | null {
    if (values.length < horizon || horizon <= 1) return null;
    const oneVariance = populationVariance(values);
    if (oneVariance === 0) return null;
    const aggregated: number[] = [];
    for (let start = 0; start <= values.length - horizon; start += 1) {
        let total = 0;
        for (let offset = 0; offset < horizon; offset += 1) total += values[start + offset]!;
        aggregated.push(total);
    }
    return populationVariance(aggregated) / (horizon * oneVariance);
}

export function normalizedAtr(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
): { value: number | null; observations: number } {
    let observations = 0;
    const ranges: number[] = [];
    for (let index = signalBarIndex - window; index < signalBarIndex; index += 1) {
        const bar = bars[index];
        const previousClose = bars[index - 1]?.[4];
        if (!bar || !finitePositive(previousClose)
            || !Number.isFinite(bar[1]) || !Number.isFinite(bar[2])
            || !Number.isFinite(bar[3]) || !Number.isFinite(bar[4])) continue;
        observations += 1;
        ranges.push(Math.max(bar[2] - bar[3], Math.abs(bar[2] - previousClose), Math.abs(bar[3] - previousClose)));
    }
    const lastClose = bars[signalBarIndex - 1]?.[4];
    if (observations !== window || !finitePositive(lastClose)) return { value: null, observations };
    return { value: populationMean(ranges) / lastClose, observations };
}

export function finiteWindow(values: readonly number[], window: number): { values: number[]; complete: boolean } {
    const result = values.slice(-window);
    return { values: result, complete: result.length === window && result.every((value) => Number.isFinite(value)) };
}
