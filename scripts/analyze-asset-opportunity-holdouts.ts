/**
 * Descriptive analysis for Asset Opportunity holdout archive files.
 *
 * The archive contains ranked rows selected by the Finder. This script does
 * not create a trading rule. It measures persistence and forward OOS results
 * for each archive sort and horizon independently.
 *
 * Usage:
 *   npm exec -- esno scripts/analyze-asset-opportunity-holdouts.ts
 *   npm exec -- esno scripts/analyze-asset-opportunity-holdouts.ts --archive-dir <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetOpportunityForwardOosBaseline } from "../lib/finder/finder-asset-opportunity-metadata";

const ARCHIVE_FILE_PATTERN = /^oos-holdout-(\d+)-bars\.txt$/;
const BLOCK_SEPARATOR = "=".repeat(80);
const REPORT_SCHEMA_VERSION = 1;
const DEFAULT_TOP_K = 10;
const DEFAULT_REPORT_CANDIDATES = 15;
const REPORT_QUESTIONS = [
    "Which archive sort has the highest average forward PnL at each tested horizon?",
    "How often are the selected observations positive for each sort and horizon?",
    "Is the typical (median) forward PnL positive, or is the average driven by outliers?",
    "What do the lower-percentile and worst forward PnL results look like?",
    "Does forward performance change between the 5-, 12-, and 15-bar horizons?",
    "Which symbol+strategy candidates recur most often in the top-10 results?",
    "Which recurring candidates stay positive across multiple forward horizons?",
    "Which candidates are supported by several independent archive sorts?",
    "Is selection concentrated in a small set of symbols or strategy families?",
    "Is a candidate's result concentrated in only a few holdout values?",
    "Does a sorted top-10 group outperform the all-candidate baseline?",
    "Do parameter fingerprints remain stable when the same candidate recurs?",
    "Which strategy library contributes the best and worst forward OOS performance?",
    "What is the descriptive forward OOS result if the worst strategy is removed?",
    "Which signal-candle hours have the best and worst forward OOS performance?",
] as const;

interface ArchiveHorizon {
    bars: number;
    averagePnlPercent: number | null;
    sampleSize: number;
}

export interface AssetOpportunityArchiveRow {
    scope?: string;
    rank?: number;
    symbol?: string;
    strategyId?: string;
    strategyName?: string;
    candidateFingerprint?: string;
    signalCandleHourUtc?: number | null;
    signalCandleHourJakarta?: number | null;
    /** Pair in-sample volatility (stdev of log-ratio returns). Absent on pre-field archives. */
    pairVolatility?: number | null;
    forwardOosPerformance?: {
        ignoreLastBars?: number;
        horizons?: ArchiveHorizon[];
    } | null;
}

export interface AssetOpportunityArchiveRecord {
    sourceFile: string;
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    sortMetric: string;
    topResults: AssetOpportunityArchiveRow[];
    baseline?: AssetOpportunityForwardOosBaseline | null;
}

interface CandidateObservation {
    holdoutBars: number;
    rank: number;
    horizons: ArchiveHorizon[];
}

export interface CandidateHoldoutAnalysis {
    candidateKey: string;
    symbol: string;
    strategyId: string;
    strategyName: string;
    candidateFingerprint: string | null;
    holdoutCount: number;
    coveragePercent: number;
    topRankCount: number;
    topRankRatePercent: number;
    medianRank: number;
    worstRank: number;
    longestContiguousHoldoutRun: number;
    allHorizonCompleteWindows: number;
    allHorizonPositiveWindows: number;
    allHorizonPositiveRatePercent: number | null;
    holdoutSeries: Array<{
        holdoutBars: number;
        rank: number;
        horizons: Record<string, { averagePnlPercent: number | null; sampleSize: number }>;
    }>;
    horizons: Record<string, {
        observedWindows: number;
        positiveWindows: number;
        positiveRatePercent: number | null;
        averagePnlPercent: number | null;
        sampleWeightedAveragePnlPercent: number | null;
        medianPnlPercent: number | null;
        p10PnlPercent: number | null;
        p25PnlPercent: number | null;
        standardDeviationPnlPercent: number | null;
        bestPnlPercent: number | null;
        worstPnlPercent: number | null;
        totalSamples: number;
    }>;
}

export interface HoldoutHorizonAnalysis {
    horizonBars: number;
    observedRows: number;
    positiveRows: number;
    positiveRatePercent: number | null;
    averagePnlPercent: number | null;
    sampleWeightedAveragePnlPercent: number | null;
    medianPnlPercent: number | null;
    p10PnlPercent: number | null;
    p25PnlPercent: number | null;
    standardDeviationPnlPercent: number | null;
    bestPnlPercent: number | null;
    worstPnlPercent: number | null;
    totalSamples: number;
    baselineAveragePnlPercent: number | null;
    baselinePositiveRatePercent: number | null;
    baselineEligibleCandidateCount: number | null;
}

export interface SortHoldoutAnalysis {
    sortMetric: string;
    holdoutBars: number[];
    rowCount: number;
    candidateCount: number;
    horizons: HoldoutHorizonAnalysis[];
    candidates: CandidateHoldoutAnalysis[];
}

export interface CrossSortCandidateAnalysis {
    candidateKey: string;
    symbol: string;
    strategyId: string;
    strategyName: string;
    candidateFingerprint: string | null;
    holdoutBars: number[];
    sortMetrics: string[];
    holdoutCoveragePercent: number;
    sortCoveragePercent: number;
    appearances: number;
    topRankAppearances: number;
    medianRank: number;
}

export interface SelectionConcentrationAnalysis {
    key: string;
    distinctCandidates: number;
    holdoutBars: number[];
    sortMetrics: string[];
    appearances: number;
    topRankAppearances: number;
    holdoutCoveragePercent: number;
    sortCoveragePercent: number;
}

export interface ParameterVariantAnalysis {
    candidateKey: string;
    symbol: string;
    strategyId: string;
    distinctFingerprints: number;
    totalAppearances: number;
    dominantFingerprint: string | null;
    dominantFingerprintAppearanceRatePercent: number | null;
    holdoutCoveragePercent: number;
    sortCoveragePercent: number;
    variants: Array<{
        fingerprint: string;
        appearances: number;
        holdoutBars: number[];
        sortMetrics: string[];
    }>;
}

export interface StrategyPerformanceAnalysis {
    strategyId: string;
    strategyName: string;
    occurrences: number;
    holdoutBars: number[];
    sortMetrics: string[];
    horizons: HoldoutHorizonAnalysis[];
}

export interface OosStrategyRemovalAnalysis {
    removedStrategyId: string;
    removedStrategyName: string;
    selectionHorizonBars: number;
    before: HoldoutHorizonAnalysis[];
    after: HoldoutHorizonAnalysis[];
}

export interface SignalCandleHourAnalysis {
    hour: number;
    occurrences: number;
    holdoutBars: number[];
    strategyCount: number;
    horizons: HoldoutHorizonAnalysis[];
}

export interface BaselineHorizonAnalysis {
    horizonBars: number;
    observedHoldouts: number;
    positiveHoldouts: number;
    positiveRatePercent: number | null;
    averagePnlPercent: number | null;
    sampleWeightedAveragePnlPercent: number | null;
    medianPnlPercent: number | null;
    p10PnlPercent: number | null;
    worstPnlPercent: number | null;
    averageEligibleCandidateCount: number | null;
    totalSamples: number;
}

export interface AssetOpportunityHoldoutAnalysisReport {
    schemaVersion: number;
    generatedAt: string;
    archiveDirectory: string;
    selectedBatchRunId: string;
    selectedBatchRunLatestTimestamp: string;
    excludedBatchRunIds: string[];
    holdoutBars: number[];
    sourceBlockCount: number;
    selectedBlockCount: number;
    analyzedBlockCount: number;
    excludedRedundantSortMetrics: string[];
    topK: number;
    candidateIdentity: "symbol+strategyId" | "symbol+strategyId+candidateFingerprint";
    parameterFingerprintAvailable: boolean;
    baselineAvailable: boolean;
    baseline: BaselineHorizonAnalysis[];
    questionsAnswered: string[];
    notes: string[];
    sorts: SortHoldoutAnalysis[];
    crossSortAgreement: CrossSortCandidateAnalysis[];
    symbolConcentration: SelectionConcentrationAnalysis[];
    strategyConcentration: SelectionConcentrationAnalysis[];
    parameterVariants: ParameterVariantAnalysis[];
    strategyPerformance: StrategyPerformanceAnalysis[];
    oosWithoutWorstStrategy: OosStrategyRemovalAnalysis | null;
    signalCandleHoursAvailable: boolean;
    signalCandleHourPerformance: {
        utc: SignalCandleHourAnalysis[];
        jakarta: SignalCandleHourAnalysis[];
    };
}

interface BatchRunGroup {
    batchRunId: string;
    records: AssetOpportunityArchiveRecord[];
    holdoutBars: Set<number>;
    latestTimestamp: string;
}

interface AnalyzeOptions {
    archiveDirectory?: string;
    batchRunId?: string;
    topK?: number;
    generatedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
}

function asPositiveInteger(value: unknown): number | null {
    const number = asFiniteNumber(value);
    if (number === null || !Number.isInteger(number) || number < 1) return null;
    return number;
}

function asNonNegativeInteger(value: unknown): number | null {
    const number = asFiniteNumber(value);
    if (number === null || !Number.isInteger(number) || number < 0) return null;
    return number;
}

function asHour(value: unknown): number | null {
    const number = asNonNegativeInteger(value);
    return number !== null && number <= 23 ? number : null;
}

function parseArchiveBaseline(value: unknown, sourceFile: string): AssetOpportunityForwardOosBaseline | null {
    if (value === undefined) return null;
    if (!isRecord(value) || !Array.isArray(value.horizons)) {
        throw new Error(`Invalid archive baseline in ${sourceFile}`);
    }
    const eligibleCandidateCount = asNonNegativeInteger(value.eligibleCandidateCount);
    if (eligibleCandidateCount === null) {
        throw new Error(`Invalid archive baseline candidate count in ${sourceFile}`);
    }
    const horizons = value.horizons.flatMap((item) => {
        if (!isRecord(item)) return [];
        const bars = asPositiveInteger(item.bars);
        const observedResults = asNonNegativeInteger(item.observedResults);
        const positiveResults = asNonNegativeInteger(item.positiveResults);
        const totalSamples = asNonNegativeInteger(item.totalSamples);
        const averagePnlPercent = item.averagePnlPercent === null ? null : asFiniteNumber(item.averagePnlPercent);
        const sampleWeightedAveragePnlPercent = item.sampleWeightedAveragePnlPercent === null
            ? null
            : asFiniteNumber(item.sampleWeightedAveragePnlPercent);
        if (bars === null || observedResults === null || positiveResults === null || totalSamples === null
            || (averagePnlPercent === null && item.averagePnlPercent !== null)
            || (sampleWeightedAveragePnlPercent === null && item.sampleWeightedAveragePnlPercent !== null)) {
            return [];
        }
        return [{
            bars,
            averagePnlPercent,
            sampleWeightedAveragePnlPercent,
            positiveResults,
            observedResults,
            totalSamples,
        }];
    });
    return { eligibleCandidateCount, horizons };
}

function parseArchiveRows(value: unknown, sourceFile: string): AssetOpportunityArchiveRow[] {
    if (!Array.isArray(value)) {
        throw new Error(`Expected a JSON array in ${sourceFile}`);
    }
    return value.map((row, index) => {
        if (!isRecord(row)) {
            throw new Error(`Expected an object at row ${index + 1} in ${sourceFile}`);
        }
        const forward = row.forwardOosPerformance;
        let forwardOosPerformance: AssetOpportunityArchiveRow["forwardOosPerformance"] = null;
        if (isRecord(forward)) {
            const horizonsValue = forward.horizons;
            const horizons = Array.isArray(horizonsValue)
                ? horizonsValue.flatMap((horizon) => {
                    if (!isRecord(horizon)) return [];
                    const bars = asPositiveInteger(horizon.bars);
                    const sampleSize = asPositiveInteger(horizon.sampleSize) ?? 0;
                    const averagePnlPercent = horizon.averagePnlPercent === null
                        ? null
                        : asFiniteNumber(horizon.averagePnlPercent);
                    if (bars === null || sampleSize < 0 || (averagePnlPercent === null && horizon.averagePnlPercent !== null)) {
                        return [];
                    }
                    return [{ bars, averagePnlPercent, sampleSize }];
                })
                : [];
            forwardOosPerformance = {
                ignoreLastBars: asPositiveInteger(forward.ignoreLastBars) ?? undefined,
                horizons,
            };
        }
        return {
            scope: typeof row.scope === "string" ? row.scope : undefined,
            rank: asPositiveInteger(row.rank) ?? undefined,
            symbol: typeof row.symbol === "string" ? row.symbol : undefined,
            strategyId: typeof row.strategyId === "string" ? row.strategyId : undefined,
            strategyName: typeof row.strategyName === "string" ? row.strategyName : undefined,
            candidateFingerprint: typeof row.candidateFingerprint === "string" ? row.candidateFingerprint : undefined,
            signalCandleHourUtc: row.signalCandleHourUtc === null
                ? null
                : asHour(row.signalCandleHourUtc),
            signalCandleHourJakarta: row.signalCandleHourJakarta === null
                ? null
                : asHour(row.signalCandleHourJakarta),
            pairVolatility: row.pairVolatility === undefined
                ? undefined
                : row.pairVolatility === null
                    ? null
                    : asFiniteNumber(row.pairVolatility),
            forwardOosPerformance,
        };
    });
}

/** Parse all delimited blocks from one archive file. */
export function parseAssetOpportunityArchiveText(text: string, sourceFile = "archive file"): AssetOpportunityArchiveRecord[] {
    const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
    const blockPattern = new RegExp(
        `^${BLOCK_SEPARATOR}\\nTimestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nArchive sort: ([^\\n]+)\\n(?:Archive baseline: ([^\\n]+)\\n)?${BLOCK_SEPARATOR}\\n([\\s\\S]*?)(?=\\n${BLOCK_SEPARATOR}\\n|$)`,
        "gm",
    );
    const records: AssetOpportunityArchiveRecord[] = [];
    for (const match of normalized.matchAll(blockPattern)) {
        const holdoutBars = Number(match[3]);
        if (!Number.isInteger(holdoutBars) || holdoutBars < 1) {
            throw new Error(`Invalid holdout value in ${sourceFile}`);
        }
        let parsedRows: unknown;
        try {
            parsedRows = JSON.parse(match[6]!);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid JSON in ${sourceFile}: ${detail}`);
        }
        records.push({
            sourceFile,
            timestamp: match[1]!,
            batchRunId: match[2]!,
            holdoutBars,
            sortMetric: match[4]!,
            topResults: parseArchiveRows(parsedRows, sourceFile),
            baseline: match[5] ? parseArchiveBaseline(JSON.parse(match[5]), sourceFile) : null,
        });
    }
    if (records.length === 0 && normalized.length > 0) {
        throw new Error(`No valid archive blocks found in ${sourceFile}`);
    }
    return records;
}

export function readAssetOpportunityArchive(archiveDirectory: string): AssetOpportunityArchiveRecord[] {
    const files = fs.readdirSync(archiveDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && ARCHIVE_FILE_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (files.length === 0) {
        throw new Error(`No oos-holdout-<N>-bars.txt files found in ${archiveDirectory}`);
    }
    return files.flatMap((file) => parseAssetOpportunityArchiveText(
        fs.readFileSync(path.join(archiveDirectory, file), "utf8"),
        file,
    ));
}

function deduplicateRecords(records: AssetOpportunityArchiveRecord[]): AssetOpportunityArchiveRecord[] {
    const latestByBlock = new Map<string, AssetOpportunityArchiveRecord>();
    for (const record of records) {
        const key = `${record.holdoutBars}|${record.sortMetric}`;
        const previous = latestByBlock.get(key);
        if (!previous || record.timestamp.localeCompare(previous.timestamp) >= 0) {
            latestByBlock.set(key, record);
        }
    }
    return [...latestByBlock.values()].sort((left, right) => {
        return left.holdoutBars - right.holdoutBars || left.sortMetric.localeCompare(right.sortMetric);
    });
}

function buildBatchRunGroups(records: AssetOpportunityArchiveRecord[]): BatchRunGroup[] {
    const groups = new Map<string, BatchRunGroup>();
    for (const record of records) {
        let group = groups.get(record.batchRunId);
        if (!group) {
            group = {
                batchRunId: record.batchRunId,
                records: [],
                holdoutBars: new Set<number>(),
                latestTimestamp: record.timestamp,
            };
            groups.set(record.batchRunId, group);
        }
        group.records.push(record);
        group.holdoutBars.add(record.holdoutBars);
        if (record.timestamp.localeCompare(group.latestTimestamp) > 0) {
            group.latestTimestamp = record.timestamp;
        }
    }
    return [...groups.values()];
}

function selectBatchRun(records: AssetOpportunityArchiveRecord[], requestedBatchRunId?: string): {
    selected: BatchRunGroup;
    excludedBatchRunIds: string[];
} {
    const groups = buildBatchRunGroups(records);
    if (groups.length === 0) throw new Error("The archive contains no batch runs");
    const selected = requestedBatchRunId
        ? groups.find((group) => group.batchRunId === requestedBatchRunId)
        : [...groups].sort((left, right) => {
            return right.holdoutBars.size - left.holdoutBars.size
                || right.latestTimestamp.localeCompare(left.latestTimestamp);
        })[0];
    if (!selected) {
        throw new Error(`Batch run not found: ${requestedBatchRunId}`);
    }
    return {
        selected: {
            ...selected,
            records: deduplicateRecords(selected.records),
        },
        excludedBatchRunIds: groups
            .filter((group) => group.batchRunId !== selected.batchRunId)
            .map((group) => group.batchRunId)
            .sort(),
    };
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!;
}

function quantile(values: number[], probability: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower]!;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function standardDeviation(values: number[]): number | null {
    if (values.length === 0) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

function percentOrNull(value: number): number | null {
    return Number.isFinite(value) ? value : null;
}

function calculateHorizonAnalysis(values: Array<{ pnlPercent: number; sampleSize: number }>, horizonBars: number): HoldoutHorizonAnalysis {
    const totalSamples = values.reduce((sum, value) => sum + value.sampleSize, 0);
    const unweightedTotal = values.reduce((sum, value) => sum + value.pnlPercent, 0);
    const weightedTotal = values.reduce((sum, value) => sum + value.pnlPercent * value.sampleSize, 0);
    const pnlValues = values.map((value) => value.pnlPercent);
    const positiveRows = values.filter((value) => value.pnlPercent > 0).length;
    return {
        horizonBars,
        observedRows: values.length,
        positiveRows,
        positiveRatePercent: values.length > 0 ? (positiveRows / values.length) * 100 : null,
        averagePnlPercent: percentOrNull(unweightedTotal / values.length),
        sampleWeightedAveragePnlPercent: totalSamples > 0 ? percentOrNull(weightedTotal / totalSamples) : null,
        medianPnlPercent: median(pnlValues),
        p10PnlPercent: quantile(pnlValues, 0.10),
        p25PnlPercent: quantile(pnlValues, 0.25),
        standardDeviationPnlPercent: standardDeviation(pnlValues),
        bestPnlPercent: values.length > 0 ? Math.max(...pnlValues) : null,
        worstPnlPercent: values.length > 0 ? Math.min(...pnlValues) : null,
        totalSamples,
        baselineAveragePnlPercent: null,
        baselinePositiveRatePercent: null,
        baselineEligibleCandidateCount: null,
    };
}

function calculateCandidateHorizonAnalysis(observations: CandidateObservation[], horizonBars: number): CandidateHoldoutAnalysis["horizons"][string] {
    const values: Array<{ pnlPercent: number; sampleSize: number }> = [];
    for (const observation of observations) {
        const horizon = observation.horizons.find((candidate) => candidate.bars === horizonBars);
        if (!horizon || horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
        values.push({ pnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize });
    }
    const result = calculateHorizonAnalysis(values, horizonBars);
    return {
        observedWindows: result.observedRows,
        positiveWindows: result.positiveRows,
        positiveRatePercent: result.positiveRatePercent,
        averagePnlPercent: result.averagePnlPercent,
        sampleWeightedAveragePnlPercent: result.sampleWeightedAveragePnlPercent,
        medianPnlPercent: result.medianPnlPercent,
        p10PnlPercent: result.p10PnlPercent,
        p25PnlPercent: result.p25PnlPercent,
        standardDeviationPnlPercent: result.standardDeviationPnlPercent,
        bestPnlPercent: result.bestPnlPercent,
        worstPnlPercent: result.worstPnlPercent,
        totalSamples: result.totalSamples,
    };
}

function longestContiguousRun(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...new Set(values)].sort((left, right) => left - right);
    let longest = 1;
    let current = 1;
    for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index] === sorted[index - 1]! + 1) {
            current += 1;
            longest = Math.max(longest, current);
        } else {
            current = 1;
        }
    }
    return longest;
}

function buildCandidateAnalysis(
    accumulator: CandidateAccumulator,
    expectedHoldoutCount: number,
    horizonBars: number[],
): CandidateHoldoutAnalysis {
    const observations = [...accumulator.observations.values()];
    const ranks = observations.map((observation) => observation.rank);
    const horizons: CandidateHoldoutAnalysis["horizons"] = {};
    for (const horizon of horizonBars) {
        horizons[String(horizon)] = calculateCandidateHorizonAnalysis(observations, horizon);
    }
    const completeHorizonObservations = observations.filter((observation) => horizonBars.length > 0 && horizonBars.every((horizonBarsValue) => {
        const horizon = observation.horizons.find((candidate) => candidate.bars === horizonBarsValue);
        return horizon !== undefined && horizon.sampleSize > 0 && horizon.averagePnlPercent !== null;
    }));
    const allHorizonPositiveWindows = completeHorizonObservations.filter((observation) => horizonBars.every((horizonBarsValue) => {
        const horizon = observation.horizons.find((candidate) => candidate.bars === horizonBarsValue);
        return horizon !== undefined && horizon.averagePnlPercent !== null && horizon.averagePnlPercent > 0;
    })).length;
    return {
        candidateKey: accumulator.candidateKey,
        symbol: accumulator.symbol,
        strategyId: accumulator.strategyId,
        strategyName: accumulator.strategyName,
        candidateFingerprint: accumulator.candidateFingerprint,
        holdoutCount: observations.length,
        coveragePercent: expectedHoldoutCount > 0 ? (observations.length / expectedHoldoutCount) * 100 : 0,
        topRankCount: observations.filter((observation) => observation.rank <= 3).length,
        topRankRatePercent: observations.length > 0
            ? (observations.filter((observation) => observation.rank <= 3).length / observations.length) * 100
            : 0,
        medianRank: median(ranks) ?? 0,
        worstRank: Math.max(...ranks),
        longestContiguousHoldoutRun: longestContiguousRun(observations.map((observation) => observation.holdoutBars)),
        allHorizonCompleteWindows: completeHorizonObservations.length,
        allHorizonPositiveWindows,
        allHorizonPositiveRatePercent: completeHorizonObservations.length > 0
            ? (allHorizonPositiveWindows / completeHorizonObservations.length) * 100
            : null,
        holdoutSeries: observations.map((observation) => ({
            holdoutBars: observation.holdoutBars,
            rank: observation.rank,
            horizons: Object.fromEntries(observation.horizons.map((horizon) => [String(horizon.bars), {
                averagePnlPercent: horizon.averagePnlPercent,
                sampleSize: horizon.sampleSize,
            }])),
        })),
        horizons,
    };
}

interface CandidateAccumulator {
    candidateKey: string;
    symbol: string;
    strategyId: string;
    strategyName: string;
    candidateFingerprint: string | null;
    observations: Map<number, CandidateObservation>;
}

function candidateKeyForRow(row: AssetOpportunityArchiveRow): string {
    return `${row.symbol!}\u0000${row.strategyId!}\u0000${row.candidateFingerprint ?? ""}`;
}

function compareCandidates(left: CandidateHoldoutAnalysis, right: CandidateHoldoutAnalysis, horizonBars: number): number {
    const leftHorizon = left.horizons[String(horizonBars)]!;
    const rightHorizon = right.horizons[String(horizonBars)]!;
    return right.holdoutCount - left.holdoutCount
        || (rightHorizon.positiveRatePercent ?? -1) - (leftHorizon.positiveRatePercent ?? -1)
        || (rightHorizon.sampleWeightedAveragePnlPercent ?? Number.NEGATIVE_INFINITY)
            - (leftHorizon.sampleWeightedAveragePnlPercent ?? Number.NEGATIVE_INFINITY)
        || left.candidateKey.localeCompare(right.candidateKey);
}

function buildBaselineHorizonAnalysis(
    records: AssetOpportunityArchiveRecord[],
    horizonBars: number,
): BaselineHorizonAnalysis | null {
    const valuesByHoldout = new Map<number, {
        horizon: NonNullable<AssetOpportunityForwardOosBaseline["horizons"]>[number];
        eligibleCandidateCount: number;
    }>();
    for (const record of records) {
        const horizon = record.baseline?.horizons.find((candidate) => candidate.bars === horizonBars);
        if (horizon && record.baseline) {
            valuesByHoldout.set(record.holdoutBars, {
                horizon,
                eligibleCandidateCount: record.baseline.eligibleCandidateCount,
            });
        }
    }
    const values = [...valuesByHoldout.values()];
    if (values.length === 0) return null;
    const pnlValues = values
        .map((value) => value.horizon.averagePnlPercent)
        .filter((value): value is number => value !== null && Number.isFinite(value));
    const totalSamples = values.reduce((sum, value) => sum + value.horizon.totalSamples, 0);
    const weightedSum = values.reduce((sum, value) => sum + (value.horizon.sampleWeightedAveragePnlPercent ?? 0) * value.horizon.totalSamples, 0);
    const positiveHoldouts = pnlValues.filter((value) => value > 0).length;
    return {
        horizonBars,
        observedHoldouts: pnlValues.length,
        positiveHoldouts,
        positiveRatePercent: pnlValues.length > 0 ? (positiveHoldouts / pnlValues.length) * 100 : null,
        averagePnlPercent: pnlValues.length > 0 ? pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length : null,
        sampleWeightedAveragePnlPercent: totalSamples > 0 ? weightedSum / totalSamples : null,
        medianPnlPercent: median(pnlValues),
        p10PnlPercent: quantile(pnlValues, 0.10),
        worstPnlPercent: pnlValues.length > 0 ? Math.min(...pnlValues) : null,
        averageEligibleCandidateCount: values.length > 0
            ? values.reduce((sum, value) => sum + value.eligibleCandidateCount, 0) / values.length
            : null,
        totalSamples,
    };
}

function buildSortAnalysis(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    expectedHoldoutCount: number,
    baselineByHorizon: Map<number, BaselineHorizonAnalysis>,
): SortHoldoutAnalysis {
    const sortMetric = records[0]!.sortMetric;
    const holdoutBars = [...new Set(records.map((record) => record.holdoutBars))].sort((left, right) => left - right);
    const candidates = new Map<string, CandidateAccumulator>();
    let rowCount = 0;
    const horizonSet = new Set<number>();

    for (const record of records) {
        const rows = record.topResults.slice(0, topK);
        const rowsByCandidate = new Map<string, AssetOpportunityArchiveRow>();
        for (const row of rows) {
            if (!row.symbol || !row.strategyId) continue;
            const candidateKey = candidateKeyForRow(row);
            const existing = rowsByCandidate.get(candidateKey);
            if (!existing || (row.rank ?? Number.MAX_SAFE_INTEGER) < (existing.rank ?? Number.MAX_SAFE_INTEGER)) {
                rowsByCandidate.set(candidateKey, row);
            }
        }
        rowCount += rowsByCandidate.size;
        for (const [candidateKey, row] of rowsByCandidate) {
            const horizons = row.forwardOosPerformance?.horizons ?? [];
            for (const horizon of horizons) horizonSet.add(horizon.bars);
            let accumulator = candidates.get(candidateKey);
            if (!accumulator) {
                accumulator = {
                    candidateKey,
                    symbol: row.symbol!,
                    strategyId: row.strategyId!,
                    strategyName: row.strategyName ?? row.strategyId!,
                    candidateFingerprint: row.candidateFingerprint ?? null,
                    observations: new Map(),
                };
                candidates.set(candidateKey, accumulator);
            }
            const rank = row.rank ?? topK;
            const previous = accumulator.observations.get(record.holdoutBars);
            if (!previous || rank < previous.rank) {
                accumulator.observations.set(record.holdoutBars, {
                    holdoutBars: record.holdoutBars,
                    rank,
                    horizons,
                });
            }
        }
    }

    const horizonBars = [...horizonSet].sort((left, right) => left - right);
    const candidateAnalyses = [...candidates.values()].map((accumulator) => {
        return buildCandidateAnalysis(
            accumulator,
            expectedHoldoutCount,
            horizonBars,
        );
    });
    const horizonAnalyses = horizonBars.map((horizonBarsValue) => {
        const values: Array<{ pnlPercent: number; sampleSize: number }> = [];
        for (const record of records) {
            for (const row of record.topResults.slice(0, topK)) {
                const horizon = row.forwardOosPerformance?.horizons?.find((candidate) => candidate.bars === horizonBarsValue);
                if (!horizon || horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
                values.push({ pnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize });
            }
        }
        const result = calculateHorizonAnalysis(values, horizonBarsValue);
        const baseline = baselineByHorizon.get(horizonBarsValue);
        if (baseline) {
            result.baselineAveragePnlPercent = baseline.averagePnlPercent;
            result.baselinePositiveRatePercent = baseline.positiveRatePercent;
            result.baselineEligibleCandidateCount = baseline.averageEligibleCandidateCount;
        }
        return result;
    });
    candidateAnalyses.sort((left, right) => compareCandidates(left, right, horizonBars[0] ?? 0));
    return {
        sortMetric,
        holdoutBars,
        rowCount,
        candidateCount: candidateAnalyses.length,
        horizons: horizonAnalyses,
        candidates: candidateAnalyses,
    };
}

interface CrossSortAccumulator {
    candidateKey: string;
    symbol: string;
    strategyId: string;
    strategyName: string;
    candidateFingerprint: string | null;
    holdoutBars: Set<number>;
    sortMetrics: Set<string>;
    appearances: number;
    topRankAppearances: number;
    ranks: number[];
}

function buildCrossSortAgreement(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    expectedHoldoutCount: number,
    expectedSortCount: number,
): CrossSortCandidateAnalysis[] {
    const candidates = new Map<string, CrossSortAccumulator>();
    for (const record of records) {
        const rowsByCandidate = new Map<string, AssetOpportunityArchiveRow>();
        for (const row of record.topResults.slice(0, topK)) {
            if (!row.symbol || !row.strategyId) continue;
            const candidateKey = candidateKeyForRow(row);
            const existing = rowsByCandidate.get(candidateKey);
            if (!existing || (row.rank ?? Number.MAX_SAFE_INTEGER) < (existing.rank ?? Number.MAX_SAFE_INTEGER)) {
                rowsByCandidate.set(candidateKey, row);
            }
        }
        for (const [candidateKey, row] of rowsByCandidate) {
            const accumulator = candidates.get(candidateKey) ?? {
                candidateKey,
                symbol: row.symbol!,
                strategyId: row.strategyId!,
                strategyName: row.strategyName ?? row.strategyId!,
                candidateFingerprint: row.candidateFingerprint ?? null,
                holdoutBars: new Set<number>(),
                sortMetrics: new Set<string>(),
                appearances: 0,
                topRankAppearances: 0,
                ranks: [],
            };
            accumulator.holdoutBars.add(record.holdoutBars);
            accumulator.sortMetrics.add(record.sortMetric);
            accumulator.appearances += 1;
            accumulator.topRankAppearances += (row.rank ?? topK) <= 3 ? 1 : 0;
            accumulator.ranks.push(row.rank ?? topK);
            candidates.set(candidateKey, accumulator);
        }
    }
    return [...candidates.values()]
        .map((candidate) => ({
            candidateKey: candidate.candidateKey,
            symbol: candidate.symbol,
            strategyId: candidate.strategyId,
            strategyName: candidate.strategyName,
            candidateFingerprint: candidate.candidateFingerprint,
            holdoutBars: [...candidate.holdoutBars].sort((left, right) => left - right),
            sortMetrics: [...candidate.sortMetrics].sort(),
            holdoutCoveragePercent: expectedHoldoutCount > 0
                ? (candidate.holdoutBars.size / expectedHoldoutCount) * 100
                : 0,
            sortCoveragePercent: expectedSortCount > 0
                ? (candidate.sortMetrics.size / expectedSortCount) * 100
                : 0,
            appearances: candidate.appearances,
            topRankAppearances: candidate.topRankAppearances,
            medianRank: median(candidate.ranks) ?? 0,
        }))
        .sort((left, right) => right.holdoutBars.length - left.holdoutBars.length
            || right.sortMetrics.length - left.sortMetrics.length
            || right.appearances - left.appearances
            || left.candidateKey.localeCompare(right.candidateKey));
}

function buildSelectionConcentration(
    candidates: CrossSortCandidateAnalysis[],
    groupBy: "symbol" | "strategyId",
    expectedHoldoutCount: number,
    expectedSortCount: number,
): SelectionConcentrationAnalysis[] {
    const groups = new Map<string, {
        candidateKeys: Set<string>;
        holdoutBars: Set<number>;
        sortMetrics: Set<string>;
        appearances: number;
        topRankAppearances: number;
    }>();
    for (const candidate of candidates) {
        const key = groupBy === "symbol" ? candidate.symbol : candidate.strategyId;
        const group = groups.get(key) ?? {
            candidateKeys: new Set<string>(),
            holdoutBars: new Set<number>(),
            sortMetrics: new Set<string>(),
            appearances: 0,
            topRankAppearances: 0,
        };
        group.candidateKeys.add(candidate.candidateKey);
        for (const holdoutBars of candidate.holdoutBars) group.holdoutBars.add(holdoutBars);
        for (const sortMetric of candidate.sortMetrics) group.sortMetrics.add(sortMetric);
        group.appearances += candidate.appearances;
        group.topRankAppearances += candidate.topRankAppearances;
        groups.set(key, group);
    }
    return [...groups.entries()]
        .map(([key, group]) => ({
            key,
            distinctCandidates: group.candidateKeys.size,
            holdoutBars: [...group.holdoutBars].sort((left, right) => left - right),
            sortMetrics: [...group.sortMetrics].sort(),
            appearances: group.appearances,
            topRankAppearances: group.topRankAppearances,
            holdoutCoveragePercent: expectedHoldoutCount > 0
                ? (group.holdoutBars.size / expectedHoldoutCount) * 100
                : 0,
            sortCoveragePercent: expectedSortCount > 0
                ? (group.sortMetrics.size / expectedSortCount) * 100
                : 0,
        }))
        .sort((left, right) => right.appearances - left.appearances
            || right.holdoutBars.length - left.holdoutBars.length
            || left.key.localeCompare(right.key));
}

function buildParameterVariantAnalysis(
    candidates: CrossSortCandidateAnalysis[],
    expectedHoldoutCount: number,
    expectedSortCount: number,
): ParameterVariantAnalysis[] {
    const groups = new Map<string, {
        symbol: string;
        strategyId: string;
        holdoutBars: Set<number>;
        sortMetrics: Set<string>;
        variants: Map<string, {
            appearances: number;
            holdoutBars: Set<number>;
            sortMetrics: Set<string>;
        }>;
    }>();
    for (const candidate of candidates) {
        const candidateKey = `${candidate.symbol} / ${candidate.strategyId}`;
        const group = groups.get(candidateKey) ?? {
            symbol: candidate.symbol,
            strategyId: candidate.strategyId,
            holdoutBars: new Set<number>(),
            sortMetrics: new Set<string>(),
            variants: new Map(),
        };
        for (const holdoutBars of candidate.holdoutBars) group.holdoutBars.add(holdoutBars);
        for (const sortMetric of candidate.sortMetrics) group.sortMetrics.add(sortMetric);
        const fingerprint = candidate.candidateFingerprint ?? "legacy";
        const variant = group.variants.get(fingerprint) ?? {
            appearances: 0,
            holdoutBars: new Set<number>(),
            sortMetrics: new Set<string>(),
        };
        variant.appearances += candidate.appearances;
        for (const holdoutBars of candidate.holdoutBars) variant.holdoutBars.add(holdoutBars);
        for (const sortMetric of candidate.sortMetrics) variant.sortMetrics.add(sortMetric);
        group.variants.set(fingerprint, variant);
        groups.set(candidateKey, group);
    }
    return [...groups.entries()]
        .map(([candidateKey, group]) => {
            const variants = [...group.variants.entries()]
                .map(([fingerprint, variant]) => ({
                    fingerprint,
                    appearances: variant.appearances,
                    holdoutBars: [...variant.holdoutBars].sort((left, right) => left - right),
                    sortMetrics: [...variant.sortMetrics].sort(),
                }))
                .sort((left, right) => right.appearances - left.appearances || left.fingerprint.localeCompare(right.fingerprint));
            const dominant = variants[0];
            const totalAppearances = variants.reduce((sum, variant) => sum + variant.appearances, 0);
            return {
                candidateKey,
                symbol: group.symbol,
                strategyId: group.strategyId,
                distinctFingerprints: variants.length,
                totalAppearances,
                dominantFingerprint: dominant?.fingerprint ?? null,
                dominantFingerprintAppearanceRatePercent: dominant && totalAppearances > 0
                    ? (dominant.appearances / totalAppearances) * 100
                    : null,
                holdoutCoveragePercent: expectedHoldoutCount > 0
                    ? (group.holdoutBars.size / expectedHoldoutCount) * 100
                    : 0,
                sortCoveragePercent: expectedSortCount > 0
                    ? (group.sortMetrics.size / expectedSortCount) * 100
                    : 0,
                variants,
            };
        })
        .sort((left, right) => right.totalAppearances - left.totalAppearances
            || left.distinctFingerprints - right.distinctFingerprints
            || left.candidateKey.localeCompare(right.candidateKey));
}

function archiveRows(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
): Array<{ record: AssetOpportunityArchiveRecord; row: AssetOpportunityArchiveRow }> {
    const rows: Array<{ record: AssetOpportunityArchiveRecord; row: AssetOpportunityArchiveRow }> = [];
    for (const record of records) {
        for (const row of record.topResults.slice(0, topK)) {
            rows.push({ record, row });
        }
    }
    return rows;
}

function buildStrategyPerformance(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    horizonBars: number[],
): StrategyPerformanceAnalysis[] {
    const groups = new Map<string, {
        strategyName: string;
        occurrences: number;
        holdoutBars: Set<number>;
        sortMetrics: Set<string>;
        values: Map<number, Array<{ pnlPercent: number; sampleSize: number }>>;
    }>();
    for (const { record, row } of archiveRows(records, topK)) {
        if (!row.strategyId) continue;
        const group = groups.get(row.strategyId) ?? {
            strategyName: row.strategyName ?? row.strategyId,
            occurrences: 0,
            holdoutBars: new Set<number>(),
            sortMetrics: new Set<string>(),
            values: new Map(),
        };
        group.occurrences += 1;
        group.holdoutBars.add(record.holdoutBars);
        group.sortMetrics.add(record.sortMetric);
        for (const horizon of row.forwardOosPerformance?.horizons ?? []) {
            if (horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
            const values = group.values.get(horizon.bars) ?? [];
            values.push({ pnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize });
            group.values.set(horizon.bars, values);
        }
        groups.set(row.strategyId, group);
    }
    const analyses = [...groups.entries()].map(([strategyId, group]) => ({
        strategyId,
        strategyName: group.strategyName,
        occurrences: group.occurrences,
        holdoutBars: [...group.holdoutBars].sort((left, right) => left - right),
        sortMetrics: [...group.sortMetrics].sort(),
        horizons: horizonBars.map((horizonBarsValue) => calculateHorizonAnalysis(
            group.values.get(horizonBarsValue) ?? [],
            horizonBarsValue,
        )),
    }));
    const primaryHorizon = horizonBars.includes(12) ? 12 : horizonBars[0] ?? 0;
    return analyses.sort((left, right) => {
        const leftAverage = left.horizons.find((horizon) => horizon.horizonBars === primaryHorizon)?.averagePnlPercent;
        const rightAverage = right.horizons.find((horizon) => horizon.horizonBars === primaryHorizon)?.averagePnlPercent;
        return (rightAverage ?? Number.NEGATIVE_INFINITY) - (leftAverage ?? Number.NEGATIVE_INFINITY)
            || right.occurrences - left.occurrences
            || left.strategyId.localeCompare(right.strategyId);
    });
}

function buildArchiveHorizonAnalyses(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    horizonBars: number[],
    excludedStrategyId?: string,
): HoldoutHorizonAnalysis[] {
    return horizonBars.map((horizonBarsValue) => {
        const values: Array<{ pnlPercent: number; sampleSize: number }> = [];
        for (const { row } of archiveRows(records, topK)) {
            if (excludedStrategyId && row.strategyId === excludedStrategyId) continue;
            const horizon = row.forwardOosPerformance?.horizons?.find((candidate) => candidate.bars === horizonBarsValue);
            if (!horizon || horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
            values.push({ pnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize });
        }
        return calculateHorizonAnalysis(values, horizonBarsValue);
    });
}

function buildOosWithoutWorstStrategy(
    strategyPerformance: StrategyPerformanceAnalysis[],
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    horizonBars: number[],
): OosStrategyRemovalAnalysis | null {
    const primaryHorizon = horizonBars.includes(12) ? 12 : horizonBars[0] ?? 0;
    const candidates = strategyPerformance
        .map((strategy) => ({
            strategy,
            average: strategy.horizons.find((horizon) => horizon.horizonBars === primaryHorizon)?.averagePnlPercent ?? null,
        }))
        .filter((value): value is { strategy: StrategyPerformanceAnalysis; average: number } => value.average !== null);
    const worst = [...candidates].sort((left, right) => left.average - right.average || left.strategy.strategyId.localeCompare(right.strategy.strategyId))[0];
    if (!worst) return null;
    return {
        removedStrategyId: worst.strategy.strategyId,
        removedStrategyName: worst.strategy.strategyName,
        selectionHorizonBars: primaryHorizon,
        before: buildArchiveHorizonAnalyses(records, topK, horizonBars),
        after: buildArchiveHorizonAnalyses(records, topK, horizonBars, worst.strategy.strategyId),
    };
}

function buildSignalCandleHourPerformance(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    horizonBars: number[],
    field: "signalCandleHourUtc" | "signalCandleHourJakarta",
): SignalCandleHourAnalysis[] {
    const groups = new Map<number, {
        occurrences: number;
        holdoutBars: Set<number>;
        strategyIds: Set<string>;
        values: Map<number, Array<{ pnlPercent: number; sampleSize: number }>>;
    }>();
    for (const { record, row } of archiveRows(records, topK)) {
        const hour = row[field];
        if (hour === null || hour === undefined) continue;
        const group = groups.get(hour) ?? {
            occurrences: 0,
            holdoutBars: new Set<number>(),
            strategyIds: new Set<string>(),
            values: new Map(),
        };
        group.occurrences += 1;
        group.holdoutBars.add(record.holdoutBars);
        if (row.strategyId) group.strategyIds.add(row.strategyId);
        for (const horizon of row.forwardOosPerformance?.horizons ?? []) {
            if (horizon.sampleSize < 1 || horizon.averagePnlPercent === null) continue;
            const values = group.values.get(horizon.bars) ?? [];
            values.push({ pnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize });
            group.values.set(horizon.bars, values);
        }
        groups.set(hour, group);
    }
    return [...groups.entries()]
        .map(([hour, group]) => ({
            hour,
            occurrences: group.occurrences,
            holdoutBars: [...group.holdoutBars].sort((left, right) => left - right),
            strategyCount: group.strategyIds.size,
            horizons: horizonBars.map((horizonBarsValue) => calculateHorizonAnalysis(
                group.values.get(horizonBarsValue) ?? [],
                horizonBarsValue,
            )),
        }))
        .sort((left, right) => left.hour - right.hour);
}

export function analyzeAssetOpportunityArchive(
    records: AssetOpportunityArchiveRecord[],
    options: AnalyzeOptions = {},
): AssetOpportunityHoldoutAnalysisReport {
    if (records.length === 0) throw new Error("The archive contains no records");
    const { selected, excludedBatchRunIds } = selectBatchRun(records, options.batchRunId);
    const availableSortMetrics = new Set(selected.records.map((record) => record.sortMetric));
    const excludedRedundantSortMetrics = availableSortMetrics.has("netProfit") && availableSortMetrics.has("netProfitPercent")
        ? ["netProfit"]
        : [];
    const analysisRecords = selected.records.filter((record) => !excludedRedundantSortMetrics.includes(record.sortMetric));
    const recordsBySort = new Map<string, AssetOpportunityArchiveRecord[]>();
    for (const record of analysisRecords) {
        const list = recordsBySort.get(record.sortMetric) ?? [];
        list.push(record);
        recordsBySort.set(record.sortMetric, list);
    }
    const holdoutBars = [...selected.holdoutBars].sort((left, right) => left - right);
    const topK = Math.max(1, Math.floor(options.topK ?? DEFAULT_TOP_K));
    const sortMetrics = [...new Set(analysisRecords.map((record) => record.sortMetric))].sort();
    const baselineHorizonBars = [...new Set(selected.records.flatMap((record) => record.baseline?.horizons.map((horizon) => horizon.bars) ?? []))]
        .sort((left, right) => left - right);
    const baseline = baselineHorizonBars
        .map((horizonBarsValue) => buildBaselineHorizonAnalysis(selected.records, horizonBarsValue))
        .filter((value): value is BaselineHorizonAnalysis => value !== null);
    const baselineByHorizon = new Map(baseline.map((value) => [value.horizonBars, value]));
    const parameterFingerprintAvailable = selected.records.some((record) => record.topResults.some((row) => Boolean(row.candidateFingerprint)));
    const sorts = [...recordsBySort.values()]
        .sort((left, right) => left[0]!.sortMetric.localeCompare(right[0]!.sortMetric))
        .map((sortRecords) => buildSortAnalysis(sortRecords, topK, holdoutBars.length, baselineByHorizon));
    const crossSortAgreement = buildCrossSortAgreement(analysisRecords, topK, holdoutBars.length, sortMetrics.length);
    const parameterVariants = parameterFingerprintAvailable
        ? buildParameterVariantAnalysis(crossSortAgreement, holdoutBars.length, sortMetrics.length)
        : [];
    const horizonBars = [...new Set(sorts.flatMap((sort) => sort.horizons.map((horizon) => horizon.horizonBars)))]
        .sort((left, right) => left - right);
    const strategyPerformance = buildStrategyPerformance(analysisRecords, topK, horizonBars);
    const oosWithoutWorstStrategy = buildOosWithoutWorstStrategy(
        strategyPerformance,
        analysisRecords,
        topK,
        horizonBars,
    );
    const signalCandleHoursAvailable = analysisRecords.some((record) => record.topResults.some((row) => (
        row.signalCandleHourUtc !== null && row.signalCandleHourUtc !== undefined
    ) || (
        row.signalCandleHourJakarta !== null && row.signalCandleHourJakarta !== undefined
    )));
    return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        archiveDirectory: options.archiveDirectory ?? "",
        selectedBatchRunId: selected.batchRunId,
        selectedBatchRunLatestTimestamp: selected.latestTimestamp,
        excludedBatchRunIds,
        holdoutBars,
        sourceBlockCount: records.length,
        selectedBlockCount: selected.records.length,
        analyzedBlockCount: analysisRecords.length,
        excludedRedundantSortMetrics,
        topK,
        candidateIdentity: parameterFingerprintAvailable
            ? "symbol+strategyId+candidateFingerprint"
            : "symbol+strategyId",
        parameterFingerprintAvailable,
        baselineAvailable: baseline.length > 0,
        baseline,
        questionsAnswered: [...REPORT_QUESTIONS],
        notes: [
            "Forward OOS metrics are descriptive evidence, not a trading rule or probability.",
            "Holdout values are overlapping/nested windows and must not be treated as independent experiments.",
            parameterFingerprintAvailable
                ? "Candidate fingerprints include entry and optional exit parameters; they are reproducibility keys, not security hashes."
                : "No parameter fingerprints are present in the selected archive; candidate persistence is symbol+strategyId only.",
            baseline.length > 0
                ? "The all-candidate baseline uses every result row before the top-N archive slice; it is not a random-trade simulation."
                : "The all-candidate baseline is unavailable because older archive blocks contain only top-N rows.",
            ...(excludedRedundantSortMetrics.length > 0
                ? ["netProfit was omitted from the detailed analysis because it duplicates netProfitPercent in the selected archive."]
                : []),
            "Each archive sort and forward horizon is analyzed independently; freshSignalLibraries is not pooled with performance sorts.",
            "The JSON report stores each candidate's per-holdout series; aggregate rows must not be treated as independent samples.",
            "Strategy contribution and worst-strategy removal are calculated from archived selected rows; removal does not rerun Finder or simulate capital, position sizing, or trade overlap.",
            signalCandleHoursAvailable
                ? "Signal candle hour is derived from latestSignalTime and reported in UTC and Asia/Jakarta; it is not necessarily the eventual trade-entry hour."
                : "Signal candle-hour analysis is unavailable because the selected archive predates signalCandleHourUtc and signalCandleHourJakarta fields.",
        ],
        sorts,
        crossSortAgreement,
        symbolConcentration: buildSelectionConcentration(crossSortAgreement, "symbol", holdoutBars.length, sortMetrics.length),
        strategyConcentration: buildSelectionConcentration(crossSortAgreement, "strategyId", holdoutBars.length, sortMetrics.length),
        parameterVariants,
        strategyPerformance,
        oosWithoutWorstStrategy,
        signalCandleHoursAvailable,
        signalCandleHourPerformance: {
            utc: signalCandleHoursAvailable
                ? buildSignalCandleHourPerformance(analysisRecords, topK, horizonBars, "signalCandleHourUtc")
                : [],
            jakarta: signalCandleHoursAvailable
                ? buildSignalCandleHourPerformance(analysisRecords, topK, horizonBars, "signalCandleHourJakarta")
                : [],
        },
    };
}

function formatNumber(value: number | null, digits = 2): string {
    return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function formatPercent(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}%`;
}

function formatCandidateHorizon(candidate: CandidateHoldoutAnalysis, horizonBars: number): string {
    const horizon = candidate.horizons[String(horizonBars)];
    if (!horizon) return "n/a";
    return `${formatPercent(horizon.averagePnlPercent)} / ${formatPercent(horizon.positiveRatePercent)}`;
}

function formatAnalysisHorizon(horizon: HoldoutHorizonAnalysis | undefined): string {
    if (!horizon) return "n/a";
    return `${formatPercent(horizon.averagePnlPercent)} / ${formatPercent(horizon.positiveRatePercent)}`;
}

function analysisHorizonValue(analysis: { horizons: HoldoutHorizonAnalysis[] }, horizonBars: number): number | null {
    return analysis.horizons.find((horizon) => horizon.horizonBars === horizonBars)?.averagePnlPercent ?? null;
}

function renderSignalCandleHourSection(
    lines: string[],
    label: string,
    hours: SignalCandleHourAnalysis[],
    primaryHorizonBars: number,
): void {
    lines.push("", `SIGNAL CANDLE HOUR — ${label} (best/worst by ${primaryHorizonBars}-bar average)`);
    if (hours.length === 0) {
        lines.push("Unavailable: new archive rows must contain signalCandleHourUtc/signalCandleHourJakarta.");
        return;
    }
    lines.push("Hour | Occurrences | Holdouts | Strategies | 5-bar avg/positive | 12-bar avg/positive | 15-bar avg/positive");
    const ranked = [...hours].sort((left, right) => {
        return (analysisHorizonValue(right, primaryHorizonBars) ?? Number.NEGATIVE_INFINITY)
            - (analysisHorizonValue(left, primaryHorizonBars) ?? Number.NEGATIVE_INFINITY)
            || right.occurrences - left.occurrences
            || left.hour - right.hour;
    });
    const selected = [...ranked.slice(0, 3), ...ranked.slice(-3)]
        .filter((hour, index, all) => all.findIndex((candidate) => candidate.hour === hour.hour) === index);
    for (const hour of selected) {
        lines.push([
            `${String(hour.hour).padStart(2, "0")}:00`,
            String(hour.occurrences),
            String(hour.holdoutBars.length),
            String(hour.strategyCount),
            formatAnalysisHorizon(hour.horizons.find((horizon) => horizon.horizonBars === 5)),
            formatAnalysisHorizon(hour.horizons.find((horizon) => horizon.horizonBars === 12)),
            formatAnalysisHorizon(hour.horizons.find((horizon) => horizon.horizonBars === 15)),
        ].join(" | "));
    }
    lines.push("Full hour breakdown is stored in JSON under signalCandleHourPerformance.");
}

function primaryCandidateHorizon(sort: SortHoldoutAnalysis): number {
    return sort.horizons.some((horizon) => horizon.horizonBars === 12)
        ? 12
        : sort.horizons[0]?.horizonBars ?? 0;
}

export function renderAssetOpportunityHoldoutReport(report: AssetOpportunityHoldoutAnalysisReport): string {
    const lines: string[] = [
        "Asset Opportunity Holdout Evidence Report",
        "===========================================",
        `Generated: ${report.generatedAt}`,
        `Selected batch run: ${report.selectedBatchRunId}`,
        `Holdout bars: ${report.holdoutBars.join(", ")}`,
        `Archive blocks analyzed: ${report.analyzedBlockCount} of ${report.selectedBlockCount} selected (${report.sourceBlockCount} source)`,
        `Candidate identity: ${report.candidateIdentity}`,
        `Parameter fingerprints: ${report.parameterFingerprintAvailable ? "available" : "not available in this archive"}`,
        `All-candidate baseline: ${report.baselineAvailable ? "available" : "not available in this archive"}`,
        "",
        "Interpretation: forward OOS results are descriptive evidence only. Holdout windows overlap, so positive percentages are not independent predictive probabilities.",
        "",
        "QUESTIONS ANSWERED BY THIS REPORT",
        ...report.questionsAnswered.map((question, index) => `${index + 1}. ${question}`),
        "",
        "FORWARD OOS SUMMARY",
        "Sort | Horizon | Positive rows | Average PnL | Median PnL | P10 PnL | Worst PnL | All-candidate avg | Delta | Samples",
    ];
    for (const sort of report.sorts) {
        for (const horizon of sort.horizons) {
            const delta = horizon.averagePnlPercent !== null && horizon.baselineAveragePnlPercent !== null
                ? horizon.averagePnlPercent - horizon.baselineAveragePnlPercent
                : null;
            lines.push([
                sort.sortMetric,
                `${horizon.horizonBars} bars`,
                `${horizon.positiveRows}/${horizon.observedRows}`,
                formatPercent(horizon.averagePnlPercent),
                formatPercent(horizon.medianPnlPercent),
                formatPercent(horizon.p10PnlPercent),
                formatPercent(horizon.worstPnlPercent),
                formatPercent(horizon.baselineAveragePnlPercent),
                formatPercent(delta),
                String(horizon.totalSamples),
            ].join(" | "));
        }
    }
    lines.push("", "STRATEGY LIBRARY FORWARD OOS CONTRIBUTION (selected top rows; sorted by primary-horizon average)");
    lines.push("Strategy | Occurrences | Holdouts | Sorts | 5-bar avg/positive | 12-bar avg/positive | 15-bar avg/positive");
    for (const strategy of report.strategyPerformance) {
        lines.push([
            strategy.strategyId,
            String(strategy.occurrences),
            String(strategy.holdoutBars.length),
            String(strategy.sortMetrics.length),
            formatAnalysisHorizon(strategy.horizons.find((horizon) => horizon.horizonBars === 5)),
            formatAnalysisHorizon(strategy.horizons.find((horizon) => horizon.horizonBars === 12)),
            formatAnalysisHorizon(strategy.horizons.find((horizon) => horizon.horizonBars === 15)),
        ].join(" | "));
    }
    lines.push("Note: occurrences can repeat the same candidate across holdout values and archive sorts; this is contribution evidence, not independent strategy backtests.");
    lines.push("", "OOS COUNTERFACTUAL — REMOVE WORST STRATEGY (row exclusion, not a rerun or portfolio simulation)");
    if (!report.oosWithoutWorstStrategy) {
        lines.push("Unavailable: no strategy has a finite forward OOS average.");
    } else {
        lines.push(`Worst strategy by ${report.oosWithoutWorstStrategy.selectionHorizonBars}-bar average: ${report.oosWithoutWorstStrategy.removedStrategyId}`);
        lines.push("Horizon | All selected rows | Without worst strategy | Change in average");
        for (const before of report.oosWithoutWorstStrategy.before) {
            const after = report.oosWithoutWorstStrategy.after.find((horizon) => horizon.horizonBars === before.horizonBars);
            const change = before.averagePnlPercent !== null && after?.averagePnlPercent !== null && after
                ? after.averagePnlPercent - before.averagePnlPercent
                : null;
            lines.push([
                `${before.horizonBars} bars`,
                `${formatAnalysisHorizon(before)} (${before.observedRows} rows)`,
                `${formatAnalysisHorizon(after)} (${after?.observedRows ?? 0} rows)`,
                formatPercent(change),
            ].join(" | "));
        }
    }
    const primaryHorizonBars = report.sorts.some((sort) => sort.horizons.some((horizon) => horizon.horizonBars === 12)) ? 12 : report.sorts[0]?.horizons[0]?.horizonBars ?? 0;
    if (report.signalCandleHoursAvailable) {
        renderSignalCandleHourSection(lines, "UTC", report.signalCandleHourPerformance.utc, primaryHorizonBars);
        renderSignalCandleHourSection(lines, "Asia/Jakarta", report.signalCandleHourPerformance.jakarta, primaryHorizonBars);
    } else {
        lines.push("", "SIGNAL CANDLE HOUR");
        lines.push("Unavailable: legacy archive rows do not contain signal candle hour fields. New batches will report UTC and Asia/Jakarta hours.");
    }
    lines.push("", `PERSISTENT CANDIDATES (one row per candidate; top ${DEFAULT_REPORT_CANDIDATES} by coverage, then 12-bar OOS consistency)`);
    for (const sort of report.sorts) {
        lines.push("", `Sort: ${sort.sortMetric}`);
        lines.push("Candidate | Coverage | Top 3% | Median rank | Longest run | 5-bar avg/positive | 12-bar avg/positive | 15-bar avg/positive | All horizons positive");
        const candidates = [...sort.candidates]
            .sort((left, right) => compareCandidates(left, right, primaryCandidateHorizon(sort)))
            .slice(0, DEFAULT_REPORT_CANDIDATES);
        for (const candidate of candidates) {
            lines.push([
                `${candidate.symbol} / ${candidate.strategyId}`,
                `${candidate.holdoutCount}/${report.holdoutBars.length} (${formatPercent(candidate.coveragePercent)})`,
                formatPercent(candidate.topRankRatePercent),
                formatNumber(candidate.medianRank),
                String(candidate.longestContiguousHoldoutRun),
                formatCandidateHorizon(candidate, 5),
                formatCandidateHorizon(candidate, 12),
                formatCandidateHorizon(candidate, 15),
                `${candidate.allHorizonPositiveWindows}/${candidate.allHorizonCompleteWindows}`,
            ].join(" | "));
        }
    }
    lines.push("", "CROSS-SORT AGREEMENT (selection concentration; do not pool these duplicate PnL observations)");
    lines.push("Candidate | Holdout coverage | Sort coverage | Appearances | Top 3 appearances | Median rank");
    for (const candidate of report.crossSortAgreement.slice(0, DEFAULT_REPORT_CANDIDATES * 2)) {
        lines.push([
            `${candidate.symbol} / ${candidate.strategyId}`,
            `${candidate.holdoutBars.length}/${report.holdoutBars.length} (${formatPercent(candidate.holdoutCoveragePercent)})`,
            `${candidate.sortMetrics.length}/${new Set(report.sorts.map((sort) => sort.sortMetric)).size} (${formatPercent(candidate.sortCoveragePercent)})`,
            String(candidate.appearances),
            String(candidate.topRankAppearances),
            formatNumber(candidate.medianRank),
        ].join(" | "));
    }
    lines.push("", "SELECTION CONCENTRATION BY SYMBOL (not a pooled performance estimate)");
    lines.push("Symbol | Candidate variants | Holdout coverage | Sort coverage | Appearances | Top 3 appearances");
    for (const group of report.symbolConcentration.slice(0, DEFAULT_REPORT_CANDIDATES)) {
        lines.push([
            group.key,
            String(group.distinctCandidates),
            `${group.holdoutBars.length}/${report.holdoutBars.length} (${formatPercent(group.holdoutCoveragePercent)})`,
            `${group.sortMetrics.length}/${report.sorts.length} (${formatPercent(group.sortCoveragePercent)})`,
            String(group.appearances),
            String(group.topRankAppearances),
        ].join(" | "));
    }
    lines.push("", "SELECTION CONCENTRATION BY STRATEGY (not a pooled performance estimate)");
    lines.push("Strategy | Candidate variants | Holdout coverage | Sort coverage | Appearances | Top 3 appearances");
    for (const group of report.strategyConcentration.slice(0, DEFAULT_REPORT_CANDIDATES)) {
        lines.push([
            group.key,
            String(group.distinctCandidates),
            `${group.holdoutBars.length}/${report.holdoutBars.length} (${formatPercent(group.holdoutCoveragePercent)})`,
            `${group.sortMetrics.length}/${report.sorts.length} (${formatPercent(group.sortCoveragePercent)})`,
            String(group.appearances),
            String(group.topRankAppearances),
        ].join(" | "));
    }
    if (report.parameterFingerprintAvailable) {
        lines.push("", "PARAMETER FINGERPRINT STABILITY (same symbol + strategy; one fingerprint means stable parameters)");
        lines.push("Candidate | Fingerprints | Dominant fingerprint | Dominant appearance rate | Appearances | Holdout coverage | Sort coverage");
        for (const candidate of report.parameterVariants.slice(0, DEFAULT_REPORT_CANDIDATES)) {
            lines.push([
                candidate.candidateKey,
                String(candidate.distinctFingerprints),
                candidate.dominantFingerprint ?? "n/a",
                formatPercent(candidate.dominantFingerprintAppearanceRatePercent),
                String(candidate.totalAppearances),
                formatPercent(candidate.holdoutCoveragePercent),
                formatPercent(candidate.sortCoveragePercent),
            ].join(" | "));
        }
    }
    lines.push("", "Per-holdout candidate series are stored in JSON under sorts[].candidates[].holdoutSeries.");
    lines.push("", "Excluded batch runs: " + (report.excludedBatchRunIds.length > 0 ? report.excludedBatchRunIds.join(", ") : "none"));
    for (const note of report.notes) lines.push(`- ${note}`);
    return `${lines.join("\n")}\n`;
}

function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

function defaultArchiveDirectory(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "archive", "asset opportunity");
}

function main(): void {
    const archiveDirectory = path.resolve(getArgument(process.argv.slice(2), "--archive-dir") ?? defaultArchiveDirectory());
    const requestedBatchRunId = getArgument(process.argv.slice(2), "--batch-run-id");
    const topKValue = Number(getArgument(process.argv.slice(2), "--top-k") ?? DEFAULT_TOP_K);
    const topK = Number.isInteger(topKValue) && topKValue > 0 ? topKValue : DEFAULT_TOP_K;
    const outputPrefix = path.resolve(getArgument(process.argv.slice(2), "--output-prefix") ?? path.join(archiveDirectory, "holdout-analysis"));
    try {
        const records = readAssetOpportunityArchive(archiveDirectory);
        const report = analyzeAssetOpportunityArchive(records, {
            archiveDirectory,
            batchRunId: requestedBatchRunId,
            topK,
        });
        const textPath = `${outputPrefix}.txt`;
        const jsonPath = `${outputPrefix}.json`;
        fs.writeFileSync(textPath, renderAssetOpportunityHoldoutReport(report), "utf8");
        fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(renderAssetOpportunityHoldoutReport(report));
        console.log(`Wrote:\n  ${textPath}\n  ${jsonPath}`);
    } catch (error) {
        console.error(`[asset-opportunity-holdouts] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedScript === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
