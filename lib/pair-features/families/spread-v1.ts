import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotBar,
} from "../types";
import { median, populationMean, populationStd, precedingCloses, precedingLogReturns, simpleRegression } from "./math";

function spreadWindow(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
): { values: number[]; observations: number; complete: boolean } {
    const closes = precedingCloses(bars, signalBarIndex, window);
    return {
        values: closes.values.map((close) => Math.log(close)),
        observations: closes.observations,
        complete: closes.complete,
    };
}

function spreadMetric(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
    calculate: (values: readonly number[]) => number | null,
): PairFeatureEvaluationResult {
    const input = spreadWindow(bars, signalBarIndex, window);
    if (!input.complete) return { value: null, observations: input.observations };
    return { value: calculate(input.values), observations: input.observations };
}

export function computeSpreadLogReturnV1(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    lookbackBars: number,
): PairFeatureEvaluationResult {
    const requiredCloses = lookbackBars + 1;
    let observations = 0;
    let complete = true;
    for (let index = signalBarIndex - requiredCloses; index < signalBarIndex; index += 1) {
        const close = bars[index]?.[4];
        if (typeof close === "number" && Number.isFinite(close) && close > 0) observations += 1;
        else complete = false;
    }
    if (!complete) return { value: null, observations };
    const value = Math.log(bars[signalBarIndex - 1]![4]) - Math.log(bars[signalBarIndex - requiredCloses]![4]);
    return { value: Object.is(value, -0) ? 0 : value, observations };
}

export function computeSpreadZScore(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return spreadMetric(bars, signalBarIndex, window, (values) => {
        const deviation = populationStd(values);
        return deviation === 0 ? null : (values.at(-1)! - populationMean(values)) / deviation;
    });
}

export function computeSpreadDistanceToMedian(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return spreadMetric(bars, signalBarIndex, window, (values) => values.at(-1)! - median(values));
}

export function computeSpreadDistanceBelowMax(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return spreadMetric(bars, signalBarIndex, window, (values) => Math.max(...values) - values.at(-1)!);
}

export function computeSpreadDistanceAboveMin(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return spreadMetric(bars, signalBarIndex, window, (values) => values.at(-1)! - Math.min(...values));
}

export function computeSpreadOlsSlope(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return spreadMetric(bars, signalBarIndex, window, (values) => {
        const regression = simpleRegression(values.map((_value, index) => index), values);
        return regression?.slope ?? null;
    });
}

export function computeSpreadEfficiency(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    const input = precedingLogReturns(bars, signalBarIndex, window);
    if (!input.complete) return { value: null, observations: input.observations };
    const totalAbs = input.values.reduce((sum, value) => sum + Math.abs(value), 0);
    return { value: totalAbs === 0 ? null : Math.abs(input.values.reduce((sum, value) => sum + value, 0)) / totalAbs, observations: input.observations };
}

export function computeSpreadIncrementStreak(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    direction: "up" | "down",
): PairFeatureEvaluationResult {
    const lastIndex = signalBarIndex - 1;
    if (lastIndex < 1 || !Number.isFinite(bars[lastIndex]?.[4]) || !Number.isFinite(bars[lastIndex - 1]?.[4])) {
        return { value: null, observations: Math.max(0, Math.min(signalBarIndex, 2)) };
    }
    let streak = 0;
    for (let index = lastIndex; index >= 1; index -= 1) {
        const current = bars[index]?.[4];
        const previous = bars[index - 1]?.[4];
        if (!Number.isFinite(current) || !Number.isFinite(previous)) break;
        const matches = direction === "up" ? current > previous : current < previous;
        if (!matches) break;
        streak += 1;
    }
    return { value: streak, observations: Math.min(signalBarIndex, 2) };
}
