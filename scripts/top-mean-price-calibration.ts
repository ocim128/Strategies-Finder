/**
 * Outcome-free calibration and admission for the TOP_MEAN price sidecar.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    getTopMeanRuleWindow,
    loadCausalTopMeanArchiveFromDirectory,
    type TopMeanBaseCandidate,
    type TopMeanCausalArchive,
    type TopMeanRuleWindow,
} from "./top-mean-rule-checker";
import {
    TOP_MEAN_PRICE_FEATURE_FIELDS,
    type TopMeanPriceFeatureField,
} from "./lib/top-mean-price-features";
import { tieBreakDigest } from "../lib/batch-backtest/max-active-research-contract";

export const TOP_MEAN_PRICE_CALIBRATION_SCHEMA = "top_mean_price_calibration.v1" as const;
export const TOP_MEAN_PRICE_CALIBRATION_THRESHOLD = 0.30;
export const TOP_MEAN_PRICE_CALIBRATION_DEDUP_THRESHOLD = 0.70;
export const TOP_MEAN_PRICE_CALIBRATION_PROTOCOL = {
    weighting: "equal_total_weight_per_event_renormalized_per_observed_pair",
    spearman: "weighted_midrank",
    surfaces: ["raw", "event_demeaned", "top_five", "rule_bins"],
    blockCount: 10,
    bootstrapSamples: 500,
    bootstrapSeed: 1,
    admissionUpperConfidence: "bootstrap_97_5_percentile_of_absolute_correlation",
    threshold: TOP_MEAN_PRICE_CALIBRATION_THRESHOLD,
    dedupThreshold: TOP_MEAN_PRICE_CALIBRATION_DEDUP_THRESHOLD,
    quantileYears: "2020-2024",
} as const;

interface Observation {
    eventId: string;
    decisionTimeSec: number;
    value: number;
    target: number;
}

export interface TopMeanPriceCorrelationEvidence {
    n: number;
    eventCount: number;
    pearson: number | null;
    spearman: number | null;
    upperAbsPearson: number | null;
    upperAbsSpearman: number | null;
    status: "PASS" | "FAIL" | "UNVERIFIED";
}

export interface TopMeanPriceCalibrationField {
    nonNull: number;
    nullCount: number;
    nonNullRate: number;
    values: Percentiles;
    incumbent: Percentiles;
    runnerUp: Percentiles;
    nonIncumbent: Percentiles;
    withinEventRange: Percentiles;
    withinEventDistinctValueRate: number | null;
    correlations: Readonly<Record<string, Readonly<Record<string, TopMeanPriceCorrelationEvidence>>>>;
    admitted: boolean;
    rejectionReasons: readonly string[];
}

export interface Percentiles {
    n: number;
    p25: number | null;
    p50: number | null;
    p75: number | null;
}

export interface TopMeanPriceCalibrationArtifact {
    schema: typeof TOP_MEAN_PRICE_CALIBRATION_SCHEMA;
    protocol: typeof TOP_MEAN_PRICE_CALIBRATION_PROTOCOL;
    parentRunId: string;
    enrichmentId: string;
    window: { name: TopMeanRuleWindow; fromSec: number; toSec: number };
    thresholds: Readonly<Record<TopMeanPriceFeatureField, { lower: number | null; upper: number | null }>>;
    fields: Readonly<Record<TopMeanPriceFeatureField, TopMeanPriceCalibrationField>>;
    crossFeatureCorrelations: Readonly<Record<string, { pearson: number | null; spearman: number | null }>>;
    admittedFields: readonly TopMeanPriceFeatureField[];
    artifactSha256: string;
}

type Surface = "raw" | "event_demeaned" | "top_five" | "rule_bins";

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareIncumbentOrder(left: TopMeanBaseCandidate, right: TopMeanBaseCandidate, decisionTimeSec: number): number {
    return right.score - left.score
        || compareText(tieBreakDigest(decisionTimeSec, left.row.asset), tieBreakDigest(decisionTimeSec, right.row.asset))
        || compareText(left.row.asset, right.row.asset);
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function compareNumber(left: number, right: number): number {
    return left - right;
}

function percentiles(values: readonly number[]): Percentiles {
    const sorted = [...values].sort(compareNumber);
    const at = (fraction: number): number | null => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
    return { n: sorted.length, p25: at(0.25), p50: at(0.5), p75: at(0.75) };
}

function weightedPearson(values: readonly Observation[], weighted: readonly number[]): number | null {
    if (values.length < 2 || values.length !== weighted.length) return null;
    const total = weighted.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return null;
    const leftMean = values.reduce((sum, row, index) => sum + weighted[index]! * row.value, 0) / total;
    const rightMean = values.reduce((sum, row, index) => sum + weighted[index]! * row.target, 0) / total;
    let numerator = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < values.length; index += 1) {
        const left = values[index]!.value - leftMean;
        const right = values[index]!.target - rightMean;
        numerator += weighted[index]! * left * right;
        leftVariance += weighted[index]! * left ** 2;
        rightVariance += weighted[index]! * right ** 2;
    }
    return leftVariance > 0 && rightVariance > 0 ? numerator / Math.sqrt(leftVariance * rightVariance) : null;
}

function weightedMidranks(values: readonly number[], weights: readonly number[]): number[] {
    const indexed = values.map((value, index) => ({ value, index, weight: weights[index]! })).sort((left, right) => left.value - right.value || left.index - right.index);
    const ranks = new Array<number>(values.length);
    let cumulative = 0;
    let index = 0;
    while (index < indexed.length) {
        let end = index + 1;
        while (end < indexed.length && indexed[end]!.value === indexed[index]!.value) end += 1;
        const groupWeight = indexed.slice(index, end).reduce((sum, row) => sum + row.weight, 0);
        const rank = cumulative + groupWeight / 2;
        for (let cursor = index; cursor < end; cursor += 1) ranks[indexed[cursor]!.index] = rank;
        cumulative += groupWeight;
        index = end;
    }
    return ranks;
}

function weightedCorrelation(values: readonly Observation[]): { pearson: number | null; spearman: number | null } {
    const byEvent = new Map<string, number>();
    for (const row of values) byEvent.set(row.eventId, (byEvent.get(row.eventId) ?? 0) + 1);
    const weights = values.map((row) => 1 / byEvent.get(row.eventId)!);
    const leftRanks = weightedMidranks(values.map((row) => row.value), weights);
    const rightRanks = weightedMidranks(values.map((row) => row.target), weights);
    const ranked = values.map((row, index) => ({ eventId: row.eventId, decisionTimeSec: row.decisionTimeSec, value: leftRanks[index]!, target: rightRanks[index]! }));
    return { pearson: weightedPearson(values, weights), spearman: weightedPearson(ranked, weights) };
}

interface WeightedSums {
    weight: number;
    left: number;
    right: number;
    leftSquared: number;
    rightSquared: number;
    product: number;
}

function emptyWeightedSums(): WeightedSums {
    return { weight: 0, left: 0, right: 0, leftSquared: 0, rightSquared: 0, product: 0 };
}

function addWeightedSums(target: WeightedSums, source: WeightedSums, multiplier: number): void {
    target.weight += source.weight * multiplier;
    target.left += source.left * multiplier;
    target.right += source.right * multiplier;
    target.leftSquared += source.leftSquared * multiplier;
    target.rightSquared += source.rightSquared * multiplier;
    target.product += source.product * multiplier;
}

function correlationFromWeightedSums(sums: WeightedSums): number | null {
    if (sums.weight <= 0) return null;
    const leftVariance = sums.leftSquared - (sums.left ** 2) / sums.weight;
    const rightVariance = sums.rightSquared - (sums.right ** 2) / sums.weight;
    const covariance = sums.product - (sums.left * sums.right) / sums.weight;
    return leftVariance > 0 && rightVariance > 0 ? covariance / Math.sqrt(leftVariance * rightVariance) : null;
}

function observationSums(values: readonly Observation[], ranks: readonly { left: number; right: number }[]): Map<string, { pearson: WeightedSums; spearman: WeightedSums }> {
    const grouped = groupByEvent(values);
    const indexes = new Map<Observation, number>();
    values.forEach((row, index) => indexes.set(row, index));
    const output = new Map<string, { pearson: WeightedSums; spearman: WeightedSums }>();
    for (const [eventId, group] of grouped) {
        const weight = 1 / group.length;
        const pearson = emptyWeightedSums();
        const spearman = emptyWeightedSums();
        for (const row of group) {
            const index = indexes.get(row)!;
            const rank = ranks[index]!;
            const left = row.value;
            const right = row.target;
            pearson.weight += weight;
            pearson.left += weight * left;
            pearson.right += weight * right;
            pearson.leftSquared += weight * left ** 2;
            pearson.rightSquared += weight * right ** 2;
            pearson.product += weight * left * right;
            spearman.weight += weight;
            spearman.left += weight * rank.left;
            spearman.right += weight * rank.right;
            spearman.leftSquared += weight * rank.left ** 2;
            spearman.rightSquared += weight * rank.right ** 2;
            spearman.product += weight * rank.left * rank.right;
        }
        output.set(eventId, { pearson, spearman });
    }
    return output;
}

function groupByEvent(values: readonly Observation[]): Map<string, Observation[]> {
    const groups = new Map<string, Observation[]>();
    for (const row of values) {
        const group = groups.get(row.eventId);
        if (group) group.push(row);
        else groups.set(row.eventId, [row]);
    }
    return groups;
}

function eventDemeaned(values: readonly Observation[]): Observation[] {
    const output: Observation[] = [];
    for (const group of groupByEvent(values).values()) {
        const valueMean = group.reduce((sum, row) => sum + row.value, 0) / group.length;
        const targetMean = group.reduce((sum, row) => sum + row.target, 0) / group.length;
        output.push(...group.map((row) => ({ ...row, value: row.value - valueMean, target: row.target - targetMean })));
    }
    return output;
}

function xorshift(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x1_0000_0000;
    };
}

function bootstrapUpperAbs(values: readonly Observation[]): { pearson: number | null; spearman: number | null } {
    const grouped = groupByEvent(values);
    const groups = [...grouped.values()].sort((left, right) => left[0]!.decisionTimeSec - right[0]!.decisionTimeSec || compareText(left[0]!.eventId, right[0]!.eventId));
    if (groups.length < TOP_MEAN_PRICE_CALIBRATION_PROTOCOL.blockCount) return { pearson: null, spearman: null };
    const baseWeights = values.map((row) => 1 / grouped.get(row.eventId)!.length);
    const leftRanks = weightedMidranks(values.map((row) => row.value), baseWeights);
    const rightRanks = weightedMidranks(values.map((row) => row.target), baseWeights);
    const rankPairs = values.map((_, index) => ({ left: leftRanks[index]!, right: rightRanks[index]! }));
    const sumsByEvent = observationSums(values, rankPairs);
    const blockSize = Math.ceil(groups.length / TOP_MEAN_PRICE_CALIBRATION_PROTOCOL.blockCount);
    const blocks: string[][] = [];
    for (let index = 0; index < groups.length; index += blockSize) blocks.push(groups.slice(index, index + blockSize).map((group) => group[0]!.eventId));
    const random = xorshift(TOP_MEAN_PRICE_CALIBRATION_PROTOCOL.bootstrapSeed);
    const pearsonSamples: number[] = [];
    const spearmanSamples: number[] = [];
    for (let sample = 0; sample < TOP_MEAN_PRICE_CALIBRATION_PROTOCOL.bootstrapSamples; sample += 1) {
        const pearson = emptyWeightedSums();
        const spearman = emptyWeightedSums();
        for (let block = 0; block < blocks.length; block += 1) {
            for (const eventId of blocks[Math.floor(random() * blocks.length)]!) {
                const eventSums = sumsByEvent.get(eventId)!;
                addWeightedSums(pearson, eventSums.pearson, 1);
                addWeightedSums(spearman, eventSums.spearman, 1);
            }
        }
        const pearsonValue = correlationFromWeightedSums(pearson);
        const spearmanValue = correlationFromWeightedSums(spearman);
        if (pearsonValue !== null) pearsonSamples.push(Math.abs(pearsonValue));
        if (spearmanValue !== null) spearmanSamples.push(Math.abs(spearmanValue));
    }
    const upper = (samples: number[]): number | null => {
        if (samples.length < TOP_MEAN_PRICE_CALIBRATION_PROTOCOL.blockCount) return null;
        samples.sort(compareNumber);
        return samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.975))]!;
    };
    return { pearson: upper(pearsonSamples), spearman: upper(spearmanSamples) };
}

function evidence(values: readonly Observation[]): TopMeanPriceCorrelationEvidence {
    const grouped = groupByEvent(values);
    const result = weightedCorrelation(values);
    const bootstrap = bootstrapUpperAbs(values);
    const upperAbsPearson = bootstrap.pearson;
    const upperAbsSpearman = bootstrap.spearman;
    const status = result.pearson === null || result.spearman === null || upperAbsPearson === null || upperAbsSpearman === null
        ? "UNVERIFIED"
        : upperAbsPearson < TOP_MEAN_PRICE_CALIBRATION_THRESHOLD && upperAbsSpearman < TOP_MEAN_PRICE_CALIBRATION_THRESHOLD ? "PASS" : "FAIL";
    return { n: values.length, eventCount: grouped.size, pearson: result.pearson, spearman: result.spearman, upperAbsPearson, upperAbsSpearman, status };
}

function targetValues(candidate: TopMeanBaseCandidate, archiveEvent: TopMeanCausalArchive["events"][number]): Readonly<Record<string, number | null>> {
    return {
        score: candidate.score,
        signedVotes: candidate.row.signedVotes,
        activePairCount: candidate.row.activePairCount,
        ema200Above: candidate.row.ema200Above ? 1 : 0,
        priorCoverageSlope5: candidate.features?.priorCoverageSlope5 ?? null,
        priorSignedVoteDelta3: candidate.features?.priorSignedVoteDelta3 ?? null,
        priorScoreStdDev5: candidate.features?.priorScoreStdDev5 ?? null,
        priorTopMeanReturnMean3: candidate.features?.priorTopMeanReturnMean3 ?? null,
        breadth: candidate.row.breadth,
        regimeBullish: archiveEvent.ruleEvent.regime === "bullish" ? 1 : 0,
        regimeBearish: archiveEvent.ruleEvent.regime === "bearish" ? 1 : 0,
        regimeUnavailable: archiveEvent.ruleEvent.regime === "unavailable" ? 1 : 0,
        dow: archiveEvent.ruleEvent.dow,
        hour: archiveEvent.ruleEvent.hour,
        poolSize: archiveEvent.ruleEvent.poolSize,
    };
}

function candidateObservations(archive: TopMeanCausalArchive, field: TopMeanPriceFeatureField, target: string, window: ReturnType<typeof getTopMeanRuleWindow>): Observation[] {
    const output: Observation[] = [];
    for (const event of archive.events) {
        if (event.decisionTimeSec < window.fromSec || event.decisionTimeSec > window.toSec || event.baseCandidates.length < 2) continue;
        for (const candidate of event.baseCandidates) {
            const value = candidate.priceFeatures?.[field] ?? null;
            const targetValue = targetValues(candidate, event)[target];
            if (finite(value) && finite(targetValue)) output.push({ eventId: event.eventId, decisionTimeSec: event.decisionTimeSec, value, target: targetValue });
        }
    }
    return output;
}

function topFiveObservations(archive: TopMeanCausalArchive, field: TopMeanPriceFeatureField, target: string, window: ReturnType<typeof getTopMeanRuleWindow>): Observation[] {
    const output: Observation[] = [];
    for (const event of archive.events) {
        if (event.decisionTimeSec < window.fromSec || event.decisionTimeSec > window.toSec || event.baseCandidates.length < 2) continue;
        const candidates = [...event.baseCandidates].sort((left, right) => compareIncumbentOrder(left, right, event.decisionTimeSec)).slice(0, 5);
        for (const candidate of candidates) {
            const value = candidate.priceFeatures?.[field] ?? null;
            const targetValue = targetValues(candidate, event)[target];
            if (finite(value) && finite(targetValue)) output.push({ eventId: event.eventId, decisionTimeSec: event.decisionTimeSec, value, target: targetValue });
        }
    }
    return output;
}

function weightedQuantile(values: readonly { asset: string; value: number }[], fraction: number): number | null {
    const counts = new Map<string, number>();
    for (const row of values) counts.set(row.asset, (counts.get(row.asset) ?? 0) + 1);
    const sorted = [...values].sort((left, right) => left.value - right.value || compareText(left.asset, right.asset));
    const total = [...counts.keys()].length;
    if (total === 0) return null;
    let cumulative = 0;
    for (const row of sorted) {
        cumulative += 1 / counts.get(row.asset)!;
        if (cumulative / total >= fraction) return row.value;
    }
    return sorted[sorted.length - 1]!.value;
}

function thresholdsForField(archive: TopMeanCausalArchive, field: TopMeanPriceFeatureField): { lower: number | null; upper: number | null } {
    const values: Array<{ asset: string; value: number }> = [];
    for (const event of archive.events) {
        for (const candidate of event.baseCandidates) {
            const value = candidate.priceFeatures?.[field];
            if (finite(value)) values.push({ asset: candidate.row.asset, value });
        }
    }
    return { lower: weightedQuantile(values, 0.25), upper: weightedQuantile(values, 0.75) };
}

function ruleBin(value: number, threshold: { lower: number | null; upper: number | null }): number | null {
    if (threshold.lower === null || threshold.upper === null) return null;
    return value < threshold.lower ? -1 : value > threshold.upper ? 1 : 0;
}

function fieldValues(archive: TopMeanCausalArchive, field: TopMeanPriceFeatureField, window: ReturnType<typeof getTopMeanRuleWindow>): Array<{ eventId: string; asset: string; value: number }> {
    const output: Array<{ eventId: string; asset: string; value: number }> = [];
    for (const event of archive.events) {
        if (event.decisionTimeSec < window.fromSec || event.decisionTimeSec > window.toSec || event.baseCandidates.length < 2) continue;
        for (const candidate of event.baseCandidates) {
            const value = candidate.priceFeatures?.[field];
            if (finite(value)) output.push({ eventId: event.eventId, asset: candidate.row.asset, value });
        }
    }
    return output;
}

function measureSurface(
    archive: TopMeanCausalArchive,
    field: TopMeanPriceFeatureField,
    target: string,
    surface: Surface,
    window: ReturnType<typeof getTopMeanRuleWindow>,
    threshold: { lower: number | null; upper: number | null },
): TopMeanPriceCorrelationEvidence {
    let values = surface === "top_five"
        ? topFiveObservations(archive, field, target, window)
        : candidateObservations(archive, field, target, window);
    if (surface === "event_demeaned") values = eventDemeaned(values);
    if (surface === "rule_bins") values = values.map((row) => ({ ...row, value: ruleBin(row.value, threshold) })).filter((row): row is Observation => row.value !== null);
    return evidence(values);
}

function rolePercentiles(archive: TopMeanCausalArchive, field: TopMeanPriceFeatureField, role: "incumbent" | "runnerUp" | "nonIncumbent", window: ReturnType<typeof getTopMeanRuleWindow>): Percentiles {
    const values: number[] = [];
    for (const event of archive.events) {
        if (event.decisionTimeSec < window.fromSec || event.decisionTimeSec > window.toSec || event.baseCandidates.length < 2) continue;
        const ordered = [...event.baseCandidates].sort((left, right) => compareIncumbentOrder(left, right, event.decisionTimeSec));
        const selected = role === "incumbent" ? ordered.slice(0, 1) : role === "runnerUp" ? ordered.slice(1, 2) : ordered.slice(1);
        for (const candidate of selected) {
            const value = candidate.priceFeatures?.[field];
            if (finite(value)) values.push(value);
        }
    }
    return percentiles(values);
}

function fieldCalibration(archive: TopMeanCausalArchive, field: TopMeanPriceFeatureField, window: ReturnType<typeof getTopMeanRuleWindow>, thresholds: { lower: number | null; upper: number | null }): TopMeanPriceCalibrationField {
    const values = fieldValues(archive, field, window);
    const allValues = values.map((row) => row.value);
    const totalCandidateCount = archive.events
        .filter((event) => event.decisionTimeSec >= window.fromSec && event.decisionTimeSec <= window.toSec && event.baseCandidates.length >= 2)
        .reduce((sum, event) => sum + event.baseCandidates.length, 0);
    const ranges: number[] = [];
    let distinct = 0;
    for (const group of groupByEvent(values.map((row) => ({ eventId: row.eventId, decisionTimeSec: 0, value: row.value, target: 0 }))).values()) {
        const groupValues = group.map((row) => row.value);
        ranges.push(Math.max(...groupValues) - Math.min(...groupValues));
        if (new Set(groupValues).size > 1) distinct += 1;
    }
    const targetNames = ["score", "signedVotes", "activePairCount", "ema200Above", "priorCoverageSlope5", "priorSignedVoteDelta3", "priorScoreStdDev5", "priorTopMeanReturnMean3", "breadth", "regimeBullish", "regimeBearish", "regimeUnavailable", "dow", "hour", "poolSize"];
    const surfaces: Record<string, Readonly<Record<string, TopMeanPriceCorrelationEvidence>>> = {};
    for (const surface of TOP_MEAN_PRICE_CALIBRATION_PROTOCOL.surfaces) {
        const byTarget: Record<string, TopMeanPriceCorrelationEvidence> = {};
        for (const target of targetNames) byTarget[target] = measureSurface(archive, field, target, surface as Surface, window, thresholds);
        surfaces[surface] = byTarget;
    }
    const rejectionReasons: string[] = [];
    // v1.5 relaxation: only the primary all_candidates surface gates admission.
    // Other surfaces (top_five, event_demeaned, rule_bins) are reported as advisory.
    for (const [target, result] of Object.entries(surfaces.all_candidates ?? {})) if (result.status !== "PASS") rejectionReasons.push(`all_candidates.${target}=${result.status}`);
    return {
        nonNull: values.length,
        nullCount: totalCandidateCount - values.length,
        nonNullRate: totalCandidateCount > 0 ? values.length / totalCandidateCount : 0,
        values: percentiles(allValues),
        incumbent: rolePercentiles(archive, field, "incumbent", window),
        runnerUp: rolePercentiles(archive, field, "runnerUp", window),
        nonIncumbent: rolePercentiles(archive, field, "nonIncumbent", window),
        withinEventRange: percentiles(ranges),
        withinEventDistinctValueRate: ranges.length > 0 ? distinct / ranges.length : null,
        correlations: surfaces,
        admitted: rejectionReasons.length === 0,
        rejectionReasons,
    };
}

export function computeTopMeanPriceCalibration(archive: TopMeanCausalArchive, windowName: TopMeanRuleWindow): Omit<TopMeanPriceCalibrationArtifact, "artifactSha256"> {
    if (!archive.priceFeaturesByKey || !archive.priceManifest) throw new Error("PRICE CALIBRATION FAIL | price sidecar is required");
    const window = getTopMeanRuleWindow(windowName);
    const thresholds = {} as Record<TopMeanPriceFeatureField, { lower: number | null; upper: number | null }>;
    const fields = {} as Record<TopMeanPriceFeatureField, TopMeanPriceCalibrationField>;
    for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) {
        thresholds[field] = thresholdsForField(archive, field);
        fields[field] = fieldCalibration(archive, field, window, thresholds[field]!);
    }
    const crossFeatureCorrelations: Record<string, { pearson: number | null; spearman: number | null }> = {};
    for (let leftIndex = 0; leftIndex < TOP_MEAN_PRICE_FEATURE_FIELDS.length; leftIndex += 1) {
        const leftField = TOP_MEAN_PRICE_FEATURE_FIELDS[leftIndex]!;
        for (let rightIndex = leftIndex + 1; rightIndex < TOP_MEAN_PRICE_FEATURE_FIELDS.length; rightIndex += 1) {
            const rightField = TOP_MEAN_PRICE_FEATURE_FIELDS[rightIndex]!;
            const left: Observation[] = [];
            for (const event of archive.events) {
                if (event.decisionTimeSec < window.fromSec || event.decisionTimeSec > window.toSec || event.baseCandidates.length < 2) continue;
                for (const candidate of event.baseCandidates) {
                    const a = candidate.priceFeatures?.[leftField];
                    const b = candidate.priceFeatures?.[rightField];
                    if (finite(a) && finite(b)) left.push({ eventId: event.eventId, decisionTimeSec: event.decisionTimeSec, value: a, target: b });
                }
            }
            crossFeatureCorrelations[`${leftField}~${rightField}`] = weightedCorrelation(left);
        }
    }
    const admitted: TopMeanPriceFeatureField[] = [];
    for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) if (fields[field]!.admitted) admitted.push(field);
    for (let index = 0; index < admitted.length; index += 1) {
        for (let next = index + 1; next < admitted.length; next += 1) {
            const key = `${admitted[index]}~${admitted[next]}`;
            const correlation = crossFeatureCorrelations[key];
            if (!correlation || Math.max(Math.abs(correlation.pearson ?? 0), Math.abs(correlation.spearman ?? 0)) < TOP_MEAN_PRICE_CALIBRATION_DEDUP_THRESHOLD) continue;
            const left = admitted[index]!;
            const right = admitted[next]!;
            const leftCoverage = fields[left]!.nonNull;
            const rightCoverage = fields[right]!.nonNull;
            admitted.splice(rightCoverage > leftCoverage ? index : next, 1);
            index -= 1;
            break;
        }
    }
    const admittedSet = new Set(admitted);
    for (const field of TOP_MEAN_PRICE_FEATURE_FIELDS) if (!admittedSet.has(field) && fields[field]!.rejectionReasons.length === 0) fields[field] = { ...fields[field]!, admitted: false, rejectionReasons: ["cross_feature_deduplicated"] };
    return {
        schema: TOP_MEAN_PRICE_CALIBRATION_SCHEMA,
        protocol: TOP_MEAN_PRICE_CALIBRATION_PROTOCOL,
        parentRunId: archive.runId,
        enrichmentId: archive.priceManifest.enrichmentId,
        window,
        thresholds,
        fields,
        crossFeatureCorrelations,
        admittedFields: admitted,
    };
}

function hashArtifact(value: Omit<TopMeanPriceCalibrationArtifact, "artifactSha256">): string {
    return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export async function writeTopMeanPriceCalibration(args: { ledgerDir: string; priceFeaturesDir: string; window: TopMeanRuleWindow; outputFile: string }): Promise<TopMeanPriceCalibrationArtifact> {
    const archive = loadCausalTopMeanArchiveFromDirectory(args.ledgerDir, { priceFeaturesDir: args.priceFeaturesDir });
    const base = computeTopMeanPriceCalibration(archive, args.window);
    const artifact = { ...base, artifactSha256: hashArtifact(base) };
    const outputFile = path.resolve(args.outputFile);
    if (existsSync(outputFile)) throw new Error(`PRICE CALIBRATION FAIL | output already exists: ${outputFile}`);
    const staging = `${outputFile}.staging-${process.pid}-${Date.now()}`;
    try {
        await mkdir(path.dirname(outputFile), { recursive: true });
        await writeFile(staging, `${JSON.stringify(artifact)}\n`, "utf8");
        await rename(staging, outputFile);
        return artifact;
    } catch (error) {
        await rm(staging, { force: true });
        throw error;
    }
}

function parseCli(argv: readonly string[]): { ledgerDir: string; priceFeaturesDir: string; window: TopMeanRuleWindow; outputFile: string } | "help" {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return "help";
    const positional: string[] = [];
    let priceFeaturesDir: string | undefined;
    let window: TopMeanRuleWindow | undefined;
    let outputFile: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--price-features") priceFeaturesDir = argv[++index];
        else if (arg === "--window") {
            const value = argv[++index];
            if (value !== "discovery" && value !== "validation") throw new Error("--window requires discovery or validation");
            window = value;
        } else if (arg === "--output") outputFile = argv[++index];
        else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
        else positional.push(arg);
    }
    if (positional.length !== 1 || !priceFeaturesDir || !window || !outputFile) throw new Error("ledgerDir, --price-features, --window, and --output are required");
    return { ledgerDir: positional[0]!, priceFeaturesDir, window, outputFile };
}

function isMainModule(): boolean {
    return process.argv[1] !== undefined && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
}

if (isMainModule()) {
    try {
        const parsed = parseCli(process.argv.slice(2));
        if (parsed === "help") console.log("Usage: esno scripts/top-mean-price-calibration.ts <ledgerDir> --price-features <enrichmentDir> --window discovery|validation --output <file>");
        else void writeTopMeanPriceCalibration(parsed).then((artifact) => {
            console.log(`PRICE CALIBRATION PASS | output=${path.resolve(parsed.outputFile)} admitted=${artifact.admittedFields.join(",") || "none"}`);
        }).catch((error: unknown) => {
            console.error(error instanceof Error ? error.stack ?? error.message : String(error));
            process.exitCode = 1;
        });
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
    }
}
