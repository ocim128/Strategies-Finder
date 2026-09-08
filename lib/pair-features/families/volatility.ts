import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotBar,
} from "../types";
import { autocorrelation, normalizedAtr, populationMean, populationStd, precedingLogReturns } from "./math";

function returnMetric(
    bars: readonly PairFeatureSnapshotBar[],
    signalBarIndex: number,
    window: number,
    calculate: (returns: readonly number[]) => number | null,
): PairFeatureEvaluationResult {
    const input = precedingLogReturns(bars, signalBarIndex, window);
    return { value: input.complete ? calculate(input.values) : null, observations: input.observations };
}

export function computeReturnStd(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return returnMetric(bars, signalBarIndex, window, populationStd);
}

export function computeDownsideRms(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return returnMetric(bars, signalBarIndex, window, (returns) => {
        const downside = returns.filter((value) => value < 0);
        return downside.length === 0 ? null : Math.sqrt(populationMean(downside.map((value) => value * value)));
    });
}

export function computeUpsideRms(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return returnMetric(bars, signalBarIndex, window, (returns) => {
        const upside = returns.filter((value) => value > 0);
        return upside.length === 0 ? null : Math.sqrt(populationMean(upside.map((value) => value * value)));
    });
}

export function computeNormalizedAtr(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return normalizedAtr(bars, signalBarIndex, window);
}

export function computeShortLongStdRatio(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number): PairFeatureEvaluationResult {
    const short = precedingLogReturns(bars, signalBarIndex, 12);
    const long = precedingLogReturns(bars, signalBarIndex, 240);
    const observations = Math.min(short.observations, long.observations);
    if (!short.complete || !long.complete) return { value: null, observations };
    const denominator = populationStd(long.values);
    return { value: denominator === 0 ? null : populationStd(short.values) / denominator, observations };
}

export function computeAbsoluteReturnAutocorrelation(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number, window: number): PairFeatureEvaluationResult {
    return returnMetric(bars, signalBarIndex, window, (returns) => autocorrelation(returns.map(Math.abs), 1));
}

export function computeGrandfatheredAtrRatio(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number): PairFeatureEvaluationResult {
    const short = normalizedAtr(bars, signalBarIndex, 5);
    const long = normalizedAtr(bars, signalBarIndex, 20);
    const observations = Math.min(short.observations, long.observations);
    if (short.value === null || long.value === null || long.value === 0) return { value: null, observations };
    return { value: short.value / long.value, observations };
}

export function computeGrandfatheredSpreadVolatilityRatio(bars: readonly PairFeatureSnapshotBar[], signalBarIndex: number): PairFeatureEvaluationResult {
    const short = precedingLogReturns(bars, signalBarIndex, 5);
    const long = precedingLogReturns(bars, signalBarIndex, 20);
    const observations = Math.min(short.observations, long.observations);
    if (!short.complete || !long.complete) return { value: null, observations };
    const denominator = populationStd(long.values);
    return { value: denominator === 0 ? null : populationStd(short.values) / denominator, observations };
}
