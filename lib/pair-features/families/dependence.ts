import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotBar,
} from "../types";
import { autocorrelation, precedingCloses, precedingLogReturns, simpleRegression, varianceRatio } from "./math";

function returnMetric(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
    calculate: (returns: readonly number[]) => number | null,
): PairFeatureEvaluationResult {
    const input = precedingLogReturns(bars, signalBarIndex, window);
    return {
        value: input.complete ? calculate(input.values) : null,
        observations: input.observations,
    };
}

export function computeReturnAutocorrelation(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
    lag: number,
): PairFeatureEvaluationResult {
    return returnMetric(bars, signalBarIndex, window, (returns) => autocorrelation(returns, lag));
}

export function computeVarianceRatio(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
    horizon: number,
): PairFeatureEvaluationResult {
    return returnMetric(bars, signalBarIndex, window, (returns) => varianceRatio(returns, horizon));
}

function arMetric(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
    calculate: (regression: { slope: number; rSquared: number | null }) => number | null,
): PairFeatureEvaluationResult {
    const input = precedingCloses(bars, signalBarIndex, window);
    if (!input.complete) return { value: null, observations: input.observations };
    const values = input.values.map((close) => Math.log(close));
    const regression = simpleRegression(values.slice(0, -1), values.slice(1));
    return { value: regression ? calculate(regression) : null, observations: input.observations };
}

export function computeAr1Slope(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return arMetric(bars, signalBarIndex, window, (regression) => regression.slope);
}

export function computeAr1RSquared(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return arMetric(bars, signalBarIndex, window, (regression) => regression.rSquared);
}

export function computeAr1HalfLife(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return arMetric(bars, signalBarIndex, window, (regression) => regression.slope > 0 && regression.slope < 1
        ? -Math.log(2) / Math.log(regression.slope)
        : null);
}

export function computeGrandfatheredReturnAutocorrelation(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number): PairFeatureEvaluationResult {
    return computeReturnAutocorrelation(bars, signalBarIndex, 20, 1);
}

export function computeGrandfatheredVarianceRatio(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number): PairFeatureEvaluationResult {
    return computeVarianceRatio(bars, signalBarIndex, 20, 5);
}

export function computeGrandfatheredHalfLife(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number): PairFeatureEvaluationResult {
    return computeAr1HalfLife(bars, signalBarIndex, 20);
}
