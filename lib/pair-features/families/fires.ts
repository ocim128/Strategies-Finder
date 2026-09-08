import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotEntry,
} from "../types";
import { populationMean, populationStd } from "./math";

export function computeGrandfatheredFireCount(
    entries: readonly PairFeatureSnapshotEntry[],
    signalBarIndex: number,
): PairFeatureEvaluationResult {
    const window = 20;
    const observations = Math.min(Math.max(signalBarIndex, 0), window);
    if (observations < window) return { value: null, observations };
    const firstBar = signalBarIndex - window;
    const count = entries.filter((entry) => entry[1] >= firstBar && entry[1] < signalBarIndex).length;
    return { value: count, observations };
}

export function computeGrandfatheredIntervalCv(
    entries: readonly PairFeatureSnapshotEntry[],
    signalBarIndex: number,
): PairFeatureEvaluationResult {
    const bars = [...new Set(entries
        .filter((entry) => entry[1] < signalBarIndex)
        .map((entry) => entry[1]))].sort((left, right) => left - right);
    const gaps: number[] = [];
    for (let index = 1; index < bars.length; index += 1) gaps.push(bars[index]! - bars[index - 1]!);
    if (gaps.length < 2) return { value: null, observations: gaps.length };
    const mean = populationMean(gaps);
    return { value: mean === 0 ? null : populationStd(gaps) / mean, observations: gaps.length };
}
