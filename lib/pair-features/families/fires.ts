import type {
    PairFeatureEvaluationResult,
    PairFeatureSnapshotEntry,
    PairFeatureSnapshotWarmupEntry,
} from "../types";
import { populationMean, populationStd } from "./math";

type HistoricalEntry = PairFeatureSnapshotEntry | PairFeatureSnapshotWarmupEntry;

function entryBarIndex(entry: HistoricalEntry): number {
    return entry.length === 4 ? entry[1] : entry[0];
}

export function computeGrandfatheredFireCount(
    entries: readonly HistoricalEntry[],
    signalBarIndex: number,
): PairFeatureEvaluationResult {
    const window = 20;
    const observations = Math.min(Math.max(signalBarIndex, 0), window);
    if (observations < window) return { value: null, observations };
    const firstBar = signalBarIndex - window;
    const count = entries.filter((entry) => entryBarIndex(entry) >= firstBar && entryBarIndex(entry) < signalBarIndex).length;
    return { value: count, observations };
}

export function computeGrandfatheredIntervalCv(
    entries: readonly HistoricalEntry[],
    signalBarIndex: number,
): PairFeatureEvaluationResult {
    const bars = [...new Set(entries
        .filter((entry) => entryBarIndex(entry) < signalBarIndex)
        .map((entry) => entryBarIndex(entry)))].sort((left, right) => left - right);
    const gaps: number[] = [];
    for (let index = 1; index < bars.length; index += 1) gaps.push(bars[index]! - bars[index - 1]!);
    if (gaps.length < 2) return { value: null, observations: gaps.length };
    const mean = populationMean(gaps);
    return { value: mean === 0 ? null : populationStd(gaps) / mean, observations: gaps.length };
}
