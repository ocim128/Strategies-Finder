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
 *
 * The CLI combines all batch runs by default. Pass --batch-run-id <id> to
 * analyze one run; repeated holdout/sort blocks keep only the latest archive.
 * Pass --basis <pair|base_only|quote_only> to re-base every forward outcome to
 * one fixed-horizon price basis (rows captured all bases in one pass; legacy
 * single-basis rows contribute only when their stored basis matches).
 *
 * Pass --mode hold_until_change to aggregate NON-overlapping rank-1 leader
 * tenures instead of every overlapping boundary: the rank-1 asset is entered
 * the first boundary it appears and held until the rank-1 pick changes to a
 * different symbol, and each tenure is measured once from its entry boundary's
 * stored forward horizon PnL. Default --mode fixed_horizon keeps the original
 * per-boundary (overlapping) aggregation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getArgument } from "./lib/cli-args";
import { formatPercent } from "./lib/asset-opportunity-analysis";
import type {
    AssetOpportunityForwardOosBaseline,
    AssetOpportunityNextExitOosBaseline,
} from "../lib/finder/finder-asset-opportunity-metadata";
import { MIN_RECURRENCE_DENSITY_FOR_INFERENCE } from "../lib/finder/finder-asset-opportunity-metrics";
import {
    ARCHIVE_FILE_PATTERN,
    parseAssetOpportunityArchiveText,
} from "../lib/asset-opportunity-explorer/archive-parser";
import { medianOrNull } from "../lib/statistics-utils";
import type {
    ArchiveHorizon,
    AssetOpportunityArchiveRecord,
    AssetOpportunityArchiveRow,
    AssetOpportunityArchiveHorizonBasis,
    ArchiveParseOptions,
} from "../lib/asset-opportunity-explorer/archive-parser";

// Parser/record types live in the shared leaf module now; the public names are
// re-exported so sibling scripts and specs keep importing them from here.
export { parseAssetOpportunityArchiveText } from "../lib/asset-opportunity-explorer/archive-parser";
export type {
    ArchiveHorizon,
    AssetOpportunityArchiveRecord,
    AssetOpportunityArchiveRow,
    AssetOpportunityArchiveHorizonBasis,
    ArchiveParseOptions,
} from "../lib/asset-opportunity-explorer/archive-parser";

const REPORT_SCHEMA_VERSION = 15;
const DEFAULT_TOP_K = 10;
const DEFAULT_REPORT_CANDIDATES = 15;
const HORIZON_BASES = ["pair", "base_only", "quote_only"] as const;
/** How the forward OOS summary aggregates archived outcomes. */
export type HoldoutCalculationMode = "fixed_horizon" | "hold_until_change";
const CALCULATION_MODES: readonly HoldoutCalculationMode[] = ["fixed_horizon", "hold_until_change"];
const THESIS_SORT_FIELDS: Readonly<Record<string, string>> = {
    netProfit: "netProfit",
    netProfitPercent: "netProfitPercent",
    expectancy: "expectancy",
    averageGain: "avgWin",
    winRate: "winRate",
    sharpeRatio: "sharpeRatio",
    profitFactor: "profitFactor",
    maxDrawdownPercent: "maxDrawdownPercent",
    totalTrades: "totalTrades",
    invertedNetProfit: "netProfit",
    invertedExpectancy: "expectancy",
    invertedAverageGain: "avgWin",
    invertedWinRate: "winRate",
    invertedSharpeRatio: "sharpeRatio",
    invertedProfitFactor: "profitFactor",
    invertedMaxDrawdownPercent: "maxDrawdownPercent",
    freshSignalLibraries: "freshSignalLibraryCount",
    freshSignalLibrariesByTrades: "freshSignalLibraryCount",
    totalTradesCapped: "totalTradesCappedValue",
    medianBarsToTp: "medianBarsToTp",
    priorTupleRecurrence: "priorTupleRecurrenceCount",
    strategyCoverageGate: "strategyCoverageCount",
    consensusRankWeight: "consensusRankWeight",
    barrierExitShare: "barrierExitShare",
    entryHourConcentration: "entryHourConcentration",
    tradeGapUniformity: "tradeGapUniformity",
    topDecileProfitShare: "topDecileProfitShare",
    winnerLoserHoldGapBars: "winnerLoserHoldGapBars",
    entryPriceRegimeMembership: "entryPriceRegimeMembership",
    equityPathLinearity: "equityPathLinearity",
};
const DERIVED_THESIS_SORTS = new Set(["payoffRatio", "tstatEdge"]);
const CONTROL_SORT_METRICS = new Set(["run_default"]);
const DISCOVERY_WARNING = "Research status: DISCOVERY ONLY — the same outcomes were inspected across many sorts. Freeze metric, direction, and K before a new confirmation run.";
const REPORT_QUESTIONS = [
    "Which archive sort has the highest average forward PnL at each tested horizon?",
    "How often are the selected observations positive for each sort and horizon?",
    "Is the typical (median) forward PnL positive, or is the average driven by outliers?",
    "What do the lower-percentile and worst forward PnL results look like?",
    "Does forward performance change between the tested forward horizons?",
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

const NEXT_EXIT_REPORT_QUESTIONS = [
    "How often do the selected opportunities exit, censor, or become unavailable within the holdout window?",
    "What is the realized PnL of observed next exits, and is it positive?",
    "Which configured exit reasons account for the observed outcomes?",
    "Why are unavailable observations missing a boundary trade, exit reason, or replay result?",
    "Does the selected top-K group differ from the all-candidate next-exit baseline?",
    "Do next-exit outcomes differ by the latest signal-candle hour?",
] as const;

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
        ongoingRows: number;
        ongoingAveragePnlPercent: number | null;
        ongoingPositiveRatePercent: number | null;
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
    /** Observations measured at the last candle because the horizon exceeded the holdout. */
    ongoingRows: number;
    /** Mark-to-market stats over the ongoing observations, kept out of the completed-horizon aggregates. */
    ongoingAveragePnlPercent: number | null;
    ongoingPositiveRatePercent: number | null;
    baselineAveragePnlPercent: number | null;
    baselinePositiveRatePercent: number | null;
    baselineEligibleCandidateCount: number | null;
    /** Pool P50 at this horizon, averaged over contributing holdouts (newer archives). */
    poolP50PnlPercent: number | null;
    /** Pool P10 band edge, averaged over contributing holdouts. */
    poolP10PnlPercent: number | null;
    /** Pool P90 band edge, averaged over contributing holdouts. */
    poolP90PnlPercent: number | null;
    /** Holdouts whose pool distribution carried this horizon. */
    poolDistributionHoldouts: number;
}

export interface SortHoldoutAnalysis {
    sortMetric: string;
    holdoutBars: number[];
    rowCount: number;
    candidateCount: number;
    horizons: HoldoutHorizonAnalysis[];
    candidates: CandidateHoldoutAnalysis[];
    /** Present only with calculation mode hold_until_change. */
    holdUntilChange?: HoldUntilChangeSortAnalysis;
}

/**
 * One non-overlapping rank-1 hold in hold_until_change mode: the symbol entered
 * when it first took rank 1 and held until a different symbol took rank 1 (a
 * strategy change on the same symbol does not close the tenure). The forward
 * outcomes are frozen at the ENTRY boundary; the archive stores no raw fills,
 * so the mark-to-market path between boundaries is not reconstructible.
 */
export interface HoldUntilChangeTenure {
    symbol: string;
    strategyId: string;
    strategyName: string;
    entryHoldoutBars: number;
    /** Boundary where the rank-1 pick changed away from this symbol; null = still held at the newest boundary. */
    exitHoldoutBars: number | null;
    /** Number of consecutive boundaries (sweep steps) the symbol stayed rank 1. */
    tenureSteps: number;
    /** Valid entry-boundary forward outcomes keyed by horizon bars. */
    horizons: Record<string, { averagePnlPercent: number; sampleSize: number; ongoing?: boolean }>;
    /**
     * Entry→exit hold return chained from the archive's 1-bar horizon across
     * the tenure's consecutive boundaries. Under next_open/next_close entry
     * each 1-bar value is the held bar's open→close move, so the chain omits
     * the close→open gaps between bars and is approximate whenever a tenure
     * spans a session gap; it is exact under signal_close entry. Null when the
     * archive stores no 1-bar horizon or a tenure step is missing or gapped.
     */
    holdReturnPercent: number | null;
    /** The chain ends at the sweep's last boundary (still held) or on an ongoing 1-bar step. */
    holdReturnOngoing?: boolean;
}

export interface HoldUntilChangeSortAnalysis {
    tenures: HoldUntilChangeTenure[];
    /** Tenure-entry outcomes aggregated per horizon, with the pooled all-candidate baseline. */
    horizons: HoldoutHorizonAnalysis[];
    /** Exact entry→exit hold returns aggregated over tenures; absent without the 1-bar horizon. */
    hold?: HoldoutHorizonAnalysis;
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

/**
 * Per-sort variant of `OosStrategyRemovalAnalysis`: for each archive sort,
 * identifies the worst strategy WITHIN that sort's selected rows (by primary
 * horizon) and reports the before/after of excluding it. The pooled
 * `oosWithoutWorstStrategy` hides per-sort variation — a strategy can be the
 * global worst while a different strategy drags each individual sort.
 */
export interface OosStrategyRemovalPerSortItem {
    sortMetric: string;
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

export interface NextExitOutcomeAnalysis {
    totalRows: number;
    observedRows: number;
    positiveRows: number;
    censoredRows: number;
    unavailableRows: number;
    positiveRatePercent: number | null;
    averagePnlPercent: number | null;
    medianPnlPercent: number | null;
    p10PnlPercent: number | null;
    worstPnlPercent: number | null;
    averageBarsHeld: number | null;
    exitReasonCounts: Record<string, number>;
    unavailableReasonCounts: Record<string, number>;
}

export interface NextExitSortAnalysis extends NextExitOutcomeAnalysis {
    sortMetric: string;
    holdoutBars: number[];
    thesisMetricEvidence: ThesisSortEvidence;
}

export type ThesisSortEvidenceStatus =
    | "measured"
    | "unavailable"
    | "insufficient_data"
    | "degenerate"
    | "not_testable"
    | "not_persisted"
    | "control";

export interface ThesisSortEvidence {
    status: ThesisSortEvidenceStatus;
    totalRows: number;
    validRows: number;
    distinctValues: number;
    /** Only populated for priorTupleRecurrence, whose inference gate is density-based. */
    positiveRows: number | null;
    /** Holdouts whose archived rank 1 and rank 2 both contain valid values. */
    comparableHoldouts: number;
    /** Comparable holdouts where the thesis value differs between rank 1 and rank 2. */
    differentiatedHoldouts: number;
    totalHoldouts: number;
}

export interface NextExitSignalCandleHourAnalysis extends NextExitOutcomeAnalysis {
    hour: number;
    holdoutBars: number[];
    strategyCount: number;
}

export interface NextExitBaselineAnalysis {
    observedHoldouts: number;
    averageEligibleCandidateCount: number | null;
    observedExits: number;
    censoredResults: number;
    unavailableResults: number;
    averagePnlPercent: number | null;
    exitReasonCounts: Record<string, number>;
    unavailableReasonCounts: Record<string, number>;
}

export interface AssetOpportunityHoldoutAnalysisReport {
    schemaVersion: number;
    generatedAt: string;
    archiveDirectory: string;
    selectedBatchRunId: string | null;
    selectedBatchRunIds: string[];
    selectedBatchRunLatestTimestamp: string;
    excludedBatchRunIds: string[];
    holdoutBars: number[];
    sourceBlockCount: number;
    selectedBlockCount: number;
    analyzedBlockCount: number;
    measurementMode: "fixed_horizon" | "next_exit";
    /** How the forward OOS summary aggregates outcomes (default fixed_horizon). */
    calculationMode: HoldoutCalculationMode;
    /** Price basis every forward outcome was re-based to; present only with --basis. */
    horizonBasis?: AssetOpportunityArchiveHorizonBasis;
    gainExclusion?: { thresholdPercent: number; excludedObservations: number };
    excludedRedundantSortMetrics: string[];
    topK: number;
    archiveMaximumRank: number;
    candidateIdentity: "symbol+strategyId" | "symbol+strategyId+candidateFingerprint";
    parameterFingerprintAvailable: boolean;
    baselineAvailable: boolean;
    baseline: BaselineHorizonAnalysis[];
    /** Distinct measurement-contract ids per analyzed batch run; empty = legacy. */
    epochRuns: Array<{ batchRunId: string; epochs: string[]; blocksMissingEpoch: number }>;
    /** Non-null when the report pools blocks with differing or absent epochs. */
    mixedEpochWarning: string | null;
    /** Analyzed blocks that carry a pool distribution. */
    poolDistributionBlocks: number;
    nextExit: {
        baseline: NextExitBaselineAnalysis | null;
        sorts: NextExitSortAnalysis[];
        signalCandleHourPerformance: {
            utc: NextExitSignalCandleHourAnalysis[];
            jakarta: NextExitSignalCandleHourAnalysis[];
        };
    } | null;
    questionsAnswered: string[];
    notes: string[];
    sorts: SortHoldoutAnalysis[];
    crossSortAgreement: CrossSortCandidateAnalysis[];
    symbolConcentration: SelectionConcentrationAnalysis[];
    strategyConcentration: SelectionConcentrationAnalysis[];
    parameterVariants: ParameterVariantAnalysis[];
    strategyPerformance: StrategyPerformanceAnalysis[];
    oosWithoutWorstStrategy: OosStrategyRemovalAnalysis | null;
    oosWithoutWorstStrategyPerSort: OosStrategyRemovalPerSortItem[];
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
    excludeGains100?: boolean;
    archiveDirectory?: string;
    batchRunId?: string;
    includeAllBatchRuns?: boolean;
    topK?: number;
    /** Report every forward outcome for one price basis instead of the run's selected basis. */
    horizonBasis?: AssetOpportunityArchiveHorizonBasis;
    /** Aggregate the forward OOS summary over non-overlapping rank-1 tenures instead of every boundary. */
    calculationMode?: HoldoutCalculationMode;
    generatedAt?: string;
}

interface HorizonBasisSelectionCounts {
    rowsFromPerBasisMap: number;
    rowsFromLegacyMatch: number;
    rowsWithoutBasis: number;
    baselinesFromPerBasisMap: number;
    baselinesFromLegacyMatch: number;
    baselinesDropped: number;
}

/**
 * Rewire each selected row's unified forward outcome (and each record's
 * baseline) to one price basis so every downstream aggregation stays
 * basis-consistent. Rows carrying the per-basis map use its entry; legacy
 * single-basis rows contribute only when their stored basis matches. A legacy
 * baseline is kept only when every forward row in the record measured the
 * requested basis — the archived aggregate cannot be re-based after the fact.
 * Provenance counts and the baseline consistency check cover the analyzed
 * `topK` row prefix only; rows beyond it are never read by any aggregation and
 * pass through untouched.
 * Rows without any forward measurement (including parse-capped stubs) carry no
 * outcome on any basis and are not counted as basis misses.
 */
export function selectForwardOosBasis(
    records: AssetOpportunityArchiveRecord[],
    basis: AssetOpportunityArchiveHorizonBasis,
    topK = Number.POSITIVE_INFINITY,
): { records: AssetOpportunityArchiveRecord[]; counts: HorizonBasisSelectionCounts } {
    const counts: HorizonBasisSelectionCounts = {
        rowsFromPerBasisMap: 0,
        rowsFromLegacyMatch: 0,
        rowsWithoutBasis: 0,
        baselinesFromPerBasisMap: 0,
        baselinesFromLegacyMatch: 0,
        baselinesDropped: 0,
    };
    const rewired = records.map((record) => {
        const topResults = record.topResults.map((row, index) => {
            // Rows outside the analyzed prefix are never read by aggregation;
            // pass them through untouched so archive-level scans (maximum rank)
            // still see them.
            if (index >= topK) return row;
            const perBasis = row.forwardOosPerformanceByBasis?.[basis];
            if (perBasis) {
                counts.rowsFromPerBasisMap += 1;
                return row.forwardOosPerformance === perBasis
                    ? row
                    : { ...row, forwardOosPerformance: perBasis };
            }
            const legacy = row.forwardOosPerformance;
            if (!legacy) return row;
            if (legacy.basis === basis) {
                counts.rowsFromLegacyMatch += 1;
                return row;
            }
            counts.rowsWithoutBasis += 1;
            return { ...row, forwardOosPerformance: null };
        });
        let baseline = record.baseline;
        const perBasisBaseline = record.baselineByBasis?.[basis];
        if (perBasisBaseline) {
            counts.baselinesFromPerBasisMap += 1;
            baseline = perBasisBaseline;
        } else if (baseline) {
            const basisConsistent = record.topResults.slice(0, topK).every((row) =>
                !row.forwardOosPerformance || row.forwardOosPerformance.basis === basis);
            if (basisConsistent) {
                counts.baselinesFromLegacyMatch += 1;
            } else {
                baseline = null;
                counts.baselinesDropped += 1;
            }
        }
        return { ...record, topResults, baseline };
    });
    return { records: rewired, counts };
}

interface BatchRunSelection {
    batchRunId: string | null;
    batchRunIds: string[];
    records: AssetOpportunityArchiveRecord[];
    holdoutBars: Set<number>;
    latestTimestamp: string;
    excludedBatchRunIds: string[];
}

/**
 * Synchronous whole-archive read for CLI use; the Explorer streams per file
 * instead. `options.maxFullRows` caps how many ranked rows per block keep their
 * full measurement data (see ArchiveParseOptions); pass the report's top-K so
 * archive-wide parse memory scales with the requested depth instead of the
 * archived rank count.
 */
export function readAssetOpportunityArchive(
    archiveDirectory: string,
    options: ArchiveParseOptions = {},
): AssetOpportunityArchiveRecord[] {
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
        options,
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

function selectBatchRun(
    records: AssetOpportunityArchiveRecord[],
    requestedBatchRunId?: string,
    includeAllBatchRuns = false,
): BatchRunSelection {
    const groups = buildBatchRunGroups(records);
    if (groups.length === 0) throw new Error("The archive contains no batch runs");
    if (includeAllBatchRuns && !requestedBatchRunId) {
        const batchRunIds = groups.map((group) => group.batchRunId).sort();
        const selectedRecords = deduplicateRecords(groups.flatMap((group) => group.records));
        return {
            batchRunId: batchRunIds.length === 1 ? batchRunIds[0]! : null,
            batchRunIds,
            records: selectedRecords,
            holdoutBars: new Set(selectedRecords.map((record) => record.holdoutBars)),
            latestTimestamp: groups.reduce((latest, group) => (
                group.latestTimestamp.localeCompare(latest) > 0 ? group.latestTimestamp : latest
            ), groups[0]!.latestTimestamp),
            excludedBatchRunIds: [],
        };
    }
    const selected = requestedBatchRunId
        ? groups.find((group) => group.batchRunId === requestedBatchRunId)
        : [...groups].sort((left, right) => {
            return right.holdoutBars.size - left.holdoutBars.size
                || right.latestTimestamp.localeCompare(left.latestTimestamp);
        })[0];
    if (!selected) {
        throw new Error(`Batch run not found: ${requestedBatchRunId}`);
    }
    const selectedRecords = deduplicateRecords(selected.records);
    return {
        batchRunId: selected.batchRunId,
        batchRunIds: [selected.batchRunId],
        records: selectedRecords,
        holdoutBars: new Set(selectedRecords.map((record) => record.holdoutBars)),
        latestTimestamp: selected.latestTimestamp,
        excludedBatchRunIds: groups
            .filter((group) => group.batchRunId !== selected.batchRunId)
            .map((group) => group.batchRunId)
            .sort(),
    };
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

/** One valid forward-OOS horizon sample in the shape the horizon aggregators consume. */
interface HorizonObservation {
    pnlPercent: number;
    sampleSize: number;
    ongoing?: boolean;
}

/** An archive horizon with a measured average PnL over at least one sample. */
type UsableArchiveHorizon = ArchiveHorizon & { averagePnlPercent: number };

/**
 * The one filter for stored horizons entering aggregation. The tenure-horizon
 * variant in HoldUntilChangeTenure.horizons is built under the same non-null
 * contract, so it feeds the same mapper.
 */
function isUsableArchiveHorizon(horizon: ArchiveHorizon): horizon is UsableArchiveHorizon {
    return horizon.sampleSize >= 1 && horizon.averagePnlPercent !== null;
}

function toHorizonObservation(horizon: {
    averagePnlPercent: number;
    sampleSize: number;
    ongoing?: boolean;
}): HorizonObservation {
    return { pnlPercent: horizon.averagePnlPercent, sampleSize: horizon.sampleSize, ongoing: horizon.ongoing === true };
}

function calculateHorizonAnalysis(
    values: HorizonObservation[],
    horizonBars: number,
): HoldoutHorizonAnalysis {
    // Aggregates describe COMPLETED horizons only: an ongoing observation is a
    // mark-to-market at the last candle, so blending it into a horizon bucket
    // would make every not-yet-reached horizon an identical copy of the
    // last-candle return. Ongoing observations get their own columns instead.
    const completed = values.filter((value) => value.ongoing !== true);
    const ongoing = values.filter((value) => value.ongoing === true);
    const totalSamples = completed.reduce((sum, value) => sum + value.sampleSize, 0);
    const unweightedTotal = completed.reduce((sum, value) => sum + value.pnlPercent, 0);
    const weightedTotal = completed.reduce((sum, value) => sum + value.pnlPercent * value.sampleSize, 0);
    const pnlValues = completed.map((value) => value.pnlPercent);
    const positiveRows = completed.filter((value) => value.pnlPercent > 0).length;
    const ongoingPnlValues = ongoing.map((value) => value.pnlPercent);
    const ongoingPositiveRows = ongoingPnlValues.filter((value) => value > 0).length;
    return {
        horizonBars,
        observedRows: completed.length,
        positiveRows,
        positiveRatePercent: completed.length > 0 ? (positiveRows / completed.length) * 100 : null,
        averagePnlPercent: percentOrNull(unweightedTotal / completed.length),
        sampleWeightedAveragePnlPercent: totalSamples > 0 ? percentOrNull(weightedTotal / totalSamples) : null,
        medianPnlPercent: medianOrNull(pnlValues),
        p10PnlPercent: quantile(pnlValues, 0.10),
        p25PnlPercent: quantile(pnlValues, 0.25),
        standardDeviationPnlPercent: standardDeviation(pnlValues),
        bestPnlPercent: completed.length > 0 ? Math.max(...pnlValues) : null,
        worstPnlPercent: completed.length > 0 ? Math.min(...pnlValues) : null,
        totalSamples,
        ongoingRows: ongoing.length,
        ongoingAveragePnlPercent: ongoing.length > 0
            ? percentOrNull(ongoingPnlValues.reduce((sum, value) => sum + value, 0) / ongoing.length)
            : null,
        ongoingPositiveRatePercent: ongoing.length > 0
            ? (ongoingPositiveRows / ongoing.length) * 100
            : null,
        baselineAveragePnlPercent: null,
        baselinePositiveRatePercent: null,
        baselineEligibleCandidateCount: null,
        poolP50PnlPercent: null,
        poolP10PnlPercent: null,
        poolP90PnlPercent: null,
        poolDistributionHoldouts: 0,
    };
}

function calculateCandidateHorizonAnalysis(observations: CandidateObservation[], horizonBars: number): CandidateHoldoutAnalysis["horizons"][string] {
    const values: HorizonObservation[] = [];
    for (const observation of observations) {
        const horizon = observation.horizons.find((candidate) => candidate.bars === horizonBars);
        if (!horizon || !isUsableArchiveHorizon(horizon)) continue;
        values.push(toHorizonObservation(horizon));
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
        ongoingRows: result.ongoingRows,
        ongoingAveragePnlPercent: result.ongoingAveragePnlPercent,
        ongoingPositiveRatePercent: result.ongoingPositiveRatePercent,
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
        medianRank: medianOrNull(ranks) ?? 0,
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
    // A basis filter can drop every forward outcome, leaving no horizon keys;
    // missing horizons sort by coverage alone instead of crashing.
    const leftHorizon = left.horizons[String(horizonBars)];
    const rightHorizon = right.horizons[String(horizonBars)];
    return right.holdoutCount - left.holdoutCount
        || (rightHorizon?.positiveRatePercent ?? -1) - (leftHorizon?.positiveRatePercent ?? -1)
        || (rightHorizon?.sampleWeightedAveragePnlPercent ?? Number.NEGATIVE_INFINITY)
            - (leftHorizon?.sampleWeightedAveragePnlPercent ?? Number.NEGATIVE_INFINITY)
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
        medianPnlPercent: medianOrNull(pnlValues),
        p10PnlPercent: quantile(pnlValues, 0.10),
        worstPnlPercent: pnlValues.length > 0 ? Math.min(...pnlValues) : null,
        averageEligibleCandidateCount: values.length > 0
            ? values.reduce((sum, value) => sum + value.eligibleCandidateCount, 0) / values.length
            : null,
        totalSamples,
    };
}

function calculateNextExitAnalysis(rows: AssetOpportunityArchiveRow[]): NextExitOutcomeAnalysis {
    const pnlValues: number[] = [];
    const barsHeldValues: number[] = [];
    const exitReasonCounts: Record<string, number> = {};
    const unavailableReasonCounts: Record<string, number> = {};
    let observedRows = 0;
    let positiveRows = 0;
    let censoredRows = 0;
    let unavailableRows = 0;

    for (const row of rows) {
        const outcome = row.nextExitOosPerformance;
        if (!outcome) {
            unavailableRows += 1;
            unavailableReasonCounts.unknown_legacy = (unavailableReasonCounts.unknown_legacy ?? 0) + 1;
            continue;
        }
        if (outcome.exitReason) {
            exitReasonCounts[outcome.exitReason] = (exitReasonCounts[outcome.exitReason] ?? 0) + 1;
        }
        if (outcome.status === "censored") {
            censoredRows += 1;
            continue;
        }
        if (outcome.status !== "exited"
            || outcome.pnlPercent === null
            || outcome.pnlPercent === undefined
            || !Number.isFinite(outcome.pnlPercent)) {
            unavailableRows += 1;
            const reason = outcome.status === "unavailable"
                ? outcome.unavailableReason ?? "unknown_legacy"
                : "unknown_legacy";
            unavailableReasonCounts[reason] = (unavailableReasonCounts[reason] ?? 0) + 1;
            continue;
        }
        observedRows += 1;
        if (outcome.pnlPercent > 0) positiveRows += 1;
        pnlValues.push(outcome.pnlPercent);
        if (outcome.barsHeld !== null
            && outcome.barsHeld !== undefined
            && Number.isFinite(outcome.barsHeld)) {
            barsHeldValues.push(outcome.barsHeld);
        }
    }

    return {
        totalRows: rows.length,
        observedRows,
        positiveRows,
        censoredRows,
        unavailableRows,
        positiveRatePercent: observedRows > 0 ? (positiveRows / observedRows) * 100 : null,
        averagePnlPercent: pnlValues.length > 0
            ? pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length
            : null,
        medianPnlPercent: medianOrNull(pnlValues),
        p10PnlPercent: quantile(pnlValues, 0.10),
        worstPnlPercent: pnlValues.length > 0 ? Math.min(...pnlValues) : null,
        averageBarsHeld: barsHeldValues.length > 0
            ? barsHeldValues.reduce((sum, value) => sum + value, 0) / barsHeldValues.length
            : null,
        exitReasonCounts,
        unavailableReasonCounts,
    };
}

function getThesisSortMetricValue(row: AssetOpportunityArchiveRow, sortMetric: string): number | null | undefined {
    const performance = row.selectionPerformance;
    if (sortMetric === "payoffRatio") {
        if (!performance
            || !("avgWin" in performance)
            || !("avgLoss" in performance)) {
            return undefined;
        }
        const avgWin = performance?.avgWin;
        const avgLoss = performance?.avgLoss;
        if (typeof avgWin !== "number" || !Number.isFinite(avgWin)
            || typeof avgLoss !== "number" || !Number.isFinite(avgLoss)) {
            return null;
        }
        if (avgLoss > 0) return avgWin / avgLoss;
        return avgWin > 0 ? Number.POSITIVE_INFINITY : 0;
    }
    if (sortMetric === "tstatEdge") {
        if (!performance
            || !("expectancy" in performance)
            || !("totalTrades" in performance)
            || !("winRate" in performance)
            || !("avgWin" in performance)
            || !("avgLoss" in performance)) {
            return undefined;
        }
        const mean = performance?.expectancy;
        const trades = performance?.totalTrades;
        const winRate = performance?.winRate;
        const avgWin = performance?.avgWin;
        const avgLoss = performance?.avgLoss;
        if (typeof mean !== "number" || !Number.isFinite(mean)
            || typeof trades !== "number" || !Number.isFinite(trades) || trades < 2
            || typeof winRate !== "number" || !Number.isFinite(winRate)
            || typeof avgWin !== "number" || !Number.isFinite(avgWin)
            || typeof avgLoss !== "number" || !Number.isFinite(avgLoss)) {
            return null;
        }
        const winProbability = Math.min(1, Math.max(0, winRate / 100));
        const variance = winProbability * (avgWin - mean) ** 2
            + (1 - winProbability) * (avgLoss + mean) ** 2;
        if (variance <= 0) return mean > 0 ? Number.POSITIVE_INFINITY : 0;
        return (mean * Math.sqrt(trades)) / Math.sqrt(variance);
    }
    const field = THESIS_SORT_FIELDS[sortMetric];
    if (!field) return undefined;
    const raw = field === "strategyCoverageCount"
        ? row.strategyCoverageCount
        : field === "freshSignalLibraryCount"
            ? row.freshSignalLibraryCount
            : field === "totalTradesCappedValue"
                ? row.totalTradesCappedValue
                : field === "consensusRankWeight"
                    ? row.consensusRankWeight
                    : performance?.[field];
    if (raw === undefined) return undefined;
    if (field === "profitFactor" && raw === null) {
        const netProfit = performance?.netProfit;
        return typeof netProfit === "number" && Number.isFinite(netProfit) && netProfit > 0
            ? Number.POSITIVE_INFINITY
            : 0;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    if (sortMetric === "medianBarsToTp" && raw < 0) return null;
    if (sortMetric === "priorTupleRecurrence" && (!Number.isInteger(raw) || raw < 0)) return null;
    if (sortMetric === "strategyCoverageGate" && (!Number.isInteger(raw) || raw < 3)) return null;
    if ((sortMetric === "barrierExitShare"
        || sortMetric === "entryHourConcentration"
        || sortMetric === "entryPriceRegimeMembership"
        || sortMetric === "equityPathLinearity")
        && (raw < 0 || raw > 1)) {
        return null;
    }
    return raw;
}

function buildThesisSortEvidence(
    records: AssetOpportunityArchiveRecord[],
    sortMetric: string,
): ThesisSortEvidence {
    const totalRows = records.reduce((sum, record) => sum + record.topResults.length, 0);
    const emptyEvidence = (status: ThesisSortEvidenceStatus): ThesisSortEvidence => ({
        status,
        totalRows,
        validRows: 0,
        distinctValues: 0,
        positiveRows: null,
        comparableHoldouts: 0,
        differentiatedHoldouts: 0,
        totalHoldouts: records.length,
    });
    if (CONTROL_SORT_METRICS.has(sortMetric)) {
        return emptyEvidence("control");
    }
    if (!THESIS_SORT_FIELDS[sortMetric] && !DERIVED_THESIS_SORTS.has(sortMetric)) {
        return emptyEvidence("not_persisted");
    }
    const rawValuesByHoldout = records.map((record) => [...record.topResults]
        .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
        .map((row) => getThesisSortMetricValue(row, sortMetric)));
    const isValidValue = (value: number | null | undefined): value is number => (
        value !== null && value !== undefined
        && (Number.isFinite(value) || value === Number.POSITIVE_INFINITY)
    );
    const valuesByHoldout = rawValuesByHoldout.map((rawValues) => rawValues
        .filter(isValidValue));
    const values = valuesByHoldout.flat();
    if (values.length === 0) {
        const metricWasPersisted = rawValuesByHoldout.some((rawValues) => rawValues.some((value) => value !== undefined));
        return {
            ...emptyEvidence(totalRows === 0 || metricWasPersisted ? "unavailable" : "not_persisted"),
            positiveRows: sortMetric === "priorTupleRecurrence" ? 0 : null,
        };
    }
    const distinctValues = new Set(values).size;
    const positiveRows = sortMetric === "priorTupleRecurrence"
        ? values.filter((value) => value > 0).length
        : null;
    const comparableHoldouts = rawValuesByHoldout.filter((holdoutValues) => (
        isValidValue(holdoutValues[0]) && isValidValue(holdoutValues[1])
    )).length;
    const differentiatedHoldouts = rawValuesByHoldout.filter((holdoutValues) => (
        isValidValue(holdoutValues[0])
        && isValidValue(holdoutValues[1])
        && holdoutValues[0] !== holdoutValues[1]
    )).length;
    const density = positiveRows === null || values.length === 0
        ? null
        : positiveRows / values.length;
    const status: ThesisSortEvidenceStatus = density !== null && density < MIN_RECURRENCE_DENSITY_FOR_INFERENCE
        ? "insufficient_data"
        : comparableHoldouts === 0
            ? "not_testable"
            : differentiatedHoldouts === 0
                ? "degenerate"
                : "measured";
    return {
        status,
        totalRows,
        validRows: values.length,
        distinctValues,
        positiveRows,
        comparableHoldouts,
        differentiatedHoldouts,
        totalHoldouts: records.length,
    };
}

function buildNextExitSortAnalysis(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
): NextExitSortAnalysis {
    const rows = records.flatMap((record) => record.topResults.slice(0, topK));
    return {
        sortMetric: records[0]!.sortMetric,
        holdoutBars: [...new Set(records.map((record) => record.holdoutBars))].sort((left, right) => left - right),
        thesisMetricEvidence: buildThesisSortEvidence(records, records[0]!.sortMetric),
        ...calculateNextExitAnalysis(rows),
    };
}

function buildNextExitBaselineAnalysis(
    records: AssetOpportunityArchiveRecord[],
): NextExitBaselineAnalysis | null {
    const baselineByHoldout = new Map<number, AssetOpportunityNextExitOosBaseline>();
    for (const record of records) {
        if (record.nextExitBaseline) baselineByHoldout.set(record.holdoutBars, record.nextExitBaseline);
    }
    const baselines = [...baselineByHoldout.values()];
    if (baselines.length === 0) return null;
    const observedExits = baselines.reduce((sum, baseline) => sum + baseline.observedExits, 0);
    const pnlTotal = baselines.reduce((sum, baseline) => {
        return sum + (baseline.averagePnlPercent ?? 0) * baseline.observedExits;
    }, 0);
    const exitReasonCounts: Record<string, number> = {};
    const unavailableReasonCounts: Record<string, number> = {};
    for (const baseline of baselines) {
        for (const [reason, count] of Object.entries(baseline.exitReasonCounts)) {
            exitReasonCounts[reason] = (exitReasonCounts[reason] ?? 0) + count;
        }
        for (const [reason, count] of Object.entries(baseline.unavailableReasonCounts ?? {})) {
            unavailableReasonCounts[reason] = (unavailableReasonCounts[reason] ?? 0) + count;
        }
    }
    return {
        observedHoldouts: baselines.length,
        averageEligibleCandidateCount: baselines.reduce((sum, baseline) => sum + baseline.eligibleCandidateCount, 0) / baselines.length,
        observedExits,
        censoredResults: baselines.reduce((sum, baseline) => sum + baseline.censoredResults, 0),
        unavailableResults: baselines.reduce((sum, baseline) => sum + baseline.unavailableResults, 0),
        averagePnlPercent: observedExits > 0 ? pnlTotal / observedExits : null,
        exitReasonCounts,
        unavailableReasonCounts,
    };
}

/**
 * Pool horizon percentiles beside the all-candidate baseline. Pool-level data
 * is repeated into every sort block of an iteration, so holdouts are collapsed
 * by (batchRunId, holdoutBars) — one entry per holdout — exactly like the
 * baseline analysis. Equal weight per holdout, same convention as the
 * baseline's median/percentile spread.
 */
function buildPoolDistributionHorizonAnalysis(
    records: AssetOpportunityArchiveRecord[],
    horizonBars: number,
): { p50: number | null; p10: number | null; p90: number | null; holdouts: number } | null {
    const valuesByHoldout = new Map<number, { p10: number | null; p50: number | null; p90: number | null }>();
    for (const record of records) {
        if (valuesByHoldout.has(record.holdoutBars)) continue;
        const horizon = record.poolDistribution?.horizons.find((candidate) => candidate.bars === horizonBars);
        if (!horizon) continue;
        valuesByHoldout.set(record.holdoutBars, { p10: horizon.p10, p50: horizon.p50, p90: horizon.p90 });
    }
    const values = [...valuesByHoldout.values()];
    if (values.length === 0) return null;
    const averageOf = (
        read: (value: { p10: number | null; p50: number | null; p90: number | null }) => number | null,
    ): number | null => {
        const finite = values.map(read).filter((value): value is number => value !== null && Number.isFinite(value));
        return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
    };
    return {
        p10: averageOf((value) => value.p10),
        p50: averageOf((value) => value.p50),
        p90: averageOf((value) => value.p90),
        holdouts: values.length,
    };
}

function buildSortHorizonAnalyses(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    horizonBars: number[],
    matchBaseline: boolean,
): HoldoutHorizonAnalysis[] {
    return horizonBars.map((horizonBarsValue) => {
        const values: HorizonObservation[] = [];
        const contributingHoldouts = new Set<number>();
        for (const record of records) {
            const selected = record.topResults.slice(0, topK);
            for (const row of selected) {
                const horizon = row.forwardOosPerformance?.horizons?.find((candidate) => candidate.bars === horizonBarsValue);
                if (!horizon || !isUsableArchiveHorizon(horizon)) continue;
                values.push(toHorizonObservation(horizon));
                if (horizon.ongoing !== true) contributingHoldouts.add(record.holdoutBars);
            }
        }
        const result = calculateHorizonAnalysis(values, horizonBarsValue);
        if (matchBaseline) {
            const matchedBaseline = buildBaselineHorizonAnalysis(
                records.filter((record) => contributingHoldouts.has(record.holdoutBars)),
                horizonBarsValue,
            );
            result.baselineAveragePnlPercent = matchedBaseline?.averagePnlPercent ?? null;
            result.baselinePositiveRatePercent = matchedBaseline?.positiveRatePercent ?? null;
            result.baselineEligibleCandidateCount = matchedBaseline?.averageEligibleCandidateCount ?? null;
            const pool = buildPoolDistributionHorizonAnalysis(
                records.filter((record) => contributingHoldouts.has(record.holdoutBars)),
                horizonBarsValue,
            );
            if (pool) {
                result.poolP10PnlPercent = pool.p10;
                result.poolP50PnlPercent = pool.p50;
                result.poolP90PnlPercent = pool.p90;
                result.poolDistributionHoldouts = pool.holdouts;
            }
        }
        return result;
    });
}

function buildSortAnalysis(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    expectedHoldoutCount: number,
): SortHoldoutAnalysis {
    const sortMetric = records[0]!.sortMetric;
    const holdoutBars = [...new Set(records.map((record) => record.holdoutBars))].sort((left, right) => left - right);
    const candidates = new Map<string, CandidateAccumulator>();
    let rowCount = 0;
    const horizonSet = new Set<number>();

    for (const record of records) {
        const rows = record.topResults.slice(0, topK);
        for (const horizon of record.baseline?.horizons ?? []) horizonSet.add(horizon.bars);
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
    const horizonAnalysisBars = [...horizonSet].sort((left, right) => left - right);
    const horizonAnalyses = buildSortHorizonAnalyses(
        records,
        topK,
        horizonAnalysisBars,
        true,
    );
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

/**
 * Chronological rank-1 leader tenures for one archive sort (hold_until_change
 * mode). The sweep's signal bar moves forward as the reserved OOS tail shrinks,
 * so chronological order is DESCENDING holdoutBars — the same convention as
 * scripts/analyze-asset-opportunity-rotation.ts. The position is entered the
 * first boundary a symbol takes rank 1 and held while rank 1 stays that symbol;
 * when a different symbol takes rank 1 the tenure closes at that boundary and
 * the next one opens there. Boundaries without a usable rank-1 row extend the
 * current tenure instead of closing it.
 */
function buildHoldUntilChangeTenures(records: AssetOpportunityArchiveRecord[]): HoldUntilChangeTenure[] {
    const ordered = [...records].sort((left, right) => right.holdoutBars - left.holdoutBars);
    interface ChainState {
        tenure: HoldUntilChangeTenure;
        symbol: string;
        product: number;
        broken: boolean;
        ongoing: boolean;
    }
    // Multiply the rank-1 row's 1-bar horizon into the chain; one missing step
    // makes the whole tenure chain unusable (an approximate product would
    // silently skip real price movement).
    const chainOneBar = (state: ChainState, row: AssetOpportunityArchiveRow): void => {
        const oneBar = row.forwardOosPerformance?.horizons?.find((horizon) => horizon.bars === 1);
        if (!oneBar || !isUsableArchiveHorizon(oneBar)) {
            state.broken = true;
            return;
        }
        state.product *= 1 + oneBar.averagePnlPercent / 100;
        if (oneBar.ongoing === true) state.ongoing = true;
    };
    const finalize = (state: ChainState): void => {
        state.tenure.holdReturnPercent = state.broken ? null : (state.product - 1) * 100;
        if (state.ongoing) state.tenure.holdReturnOngoing = true;
    };
    const tenures: HoldUntilChangeTenure[] = [];
    let current: ChainState | null = null;
    let previousHoldoutBars: number | null = null;
    for (const record of ordered) {
        const consecutive = previousHoldoutBars !== null && previousHoldoutBars - record.holdoutBars === 1;
        previousHoldoutBars = record.holdoutBars;
        let rankOne: AssetOpportunityArchiveRow | null = null;
        for (const row of record.topResults) {
            if (!row.symbol) continue;
            if (!rankOne || (row.rank ?? Number.MAX_SAFE_INTEGER) < (rankOne.rank ?? Number.MAX_SAFE_INTEGER)) rankOne = row;
        }
        if (!rankOne?.symbol) {
            // No usable rank-1 this boundary: keep holding, but the chain loses
            // its step, so the exact hold return is no longer computable.
            if (current) {
                current.tenure.tenureSteps += 1;
                current.broken = true;
            }
            continue;
        }
        if (current && current.symbol === rankOne.symbol) {
            current.tenure.tenureSteps += 1;
            if (consecutive) chainOneBar(current, rankOne);
            else current.broken = true;
            continue;
        }
        if (current) {
            current.tenure.exitHoldoutBars = record.holdoutBars;
            // A gap before the rotation means the outgoing hold spans bars that
            // were never measured — the truncated product must not be published.
            if (!consecutive) current.broken = true;
            finalize(current);
        }
        const horizons: HoldUntilChangeTenure["horizons"] = {};
        for (const horizon of rankOne.forwardOosPerformance?.horizons ?? []) {
            if (!isUsableArchiveHorizon(horizon)) continue;
            horizons[String(horizon.bars)] = {
                averagePnlPercent: horizon.averagePnlPercent,
                sampleSize: horizon.sampleSize,
                ...(horizon.ongoing === true ? { ongoing: true } : {}),
            };
        }
        const tenure: HoldUntilChangeTenure = {
            symbol: rankOne.symbol,
            strategyId: rankOne.strategyId ?? "unknown",
            strategyName: rankOne.strategyName ?? rankOne.strategyId ?? "unknown",
            entryHoldoutBars: record.holdoutBars,
            exitHoldoutBars: null,
            tenureSteps: 1,
            horizons,
            holdReturnPercent: null,
        };
        const state: ChainState = { tenure, symbol: rankOne.symbol, product: 1, broken: false, ongoing: false };
        chainOneBar(state, rankOne);
        tenures.push(tenure);
        current = state;
    }
    if (current) {
        finalize(current);
        // Still held at the newest boundary: mark-to-market, not a realized change.
        current.tenure.holdReturnOngoing = true;
    }
    return tenures;
}

/**
 * Aggregate the entry→exit hold returns (horizonBars 0 marks this as the hold
 * aggregation, not a fixed horizon). Open tenures are mark-to-market and land
 * in the Ongoing columns instead of the completed aggregates. See
 * HoldUntilChangeTenure.holdReturnPercent for the chain's gap caveat.
 */
function buildHoldUntilChangeHoldAnalysis(tenures: HoldUntilChangeTenure[]): HoldoutHorizonAnalysis | null {
    const values = tenures.flatMap((tenure) => tenure.holdReturnPercent === null
        ? []
        : [{ pnlPercent: tenure.holdReturnPercent, sampleSize: 1, ongoing: tenure.holdReturnOngoing === true }]);
    if (values.length === 0) return null;
    return calculateHorizonAnalysis(values, 0);
}

/**
 * Per-horizon aggregation of one sort's tenure-entry outcomes. Unlike the
 * fixed-horizon rows, each tenure contributes once (non-overlapping by
 * construction) and the all-candidate comparison uses the archived baseline
 * pooled over EVERY holdout: a tenure spans many boundaries, so the
 * matched-holdout subset used by fixed-horizon rows is not defined here.
 */
function buildHoldUntilChangeHorizonAnalyses(
    records: AssetOpportunityArchiveRecord[],
    tenures: HoldUntilChangeTenure[],
): HoldoutHorizonAnalysis[] {
    const horizonSet = new Set<number>();
    for (const record of records) {
        for (const horizon of record.baseline?.horizons ?? []) horizonSet.add(horizon.bars);
    }
    for (const tenure of tenures) {
        for (const bars of Object.keys(tenure.horizons)) horizonSet.add(Number(bars));
    }
    return [...horizonSet].sort((left, right) => left - right).map((horizonBars) => {
        const values = tenures.flatMap((tenure) => {
            const horizon = tenure.horizons[String(horizonBars)];
            return horizon
                ? [toHorizonObservation(horizon)]
                : [];
        });
        const result = calculateHorizonAnalysis(values, horizonBars);
        const baseline = buildBaselineHorizonAnalysis(records, horizonBars);
        result.baselineAveragePnlPercent = baseline?.averagePnlPercent ?? null;
        result.baselinePositiveRatePercent = baseline?.positiveRatePercent ?? null;
        result.baselineEligibleCandidateCount = baseline?.averageEligibleCandidateCount ?? null;
        return result;
    });
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
            medianRank: medianOrNull(candidate.ranks) ?? 0,
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
        values: Map<number, HorizonObservation[]>;
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
            if (!isUsableArchiveHorizon(horizon)) continue;
            const values = group.values.get(horizon.bars) ?? [];
            values.push(toHorizonObservation(horizon));
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
        const values: HorizonObservation[] = [];
        for (const { row } of archiveRows(records, topK)) {
            if (excludedStrategyId && row.strategyId === excludedStrategyId) continue;
            const horizon = row.forwardOosPerformance?.horizons?.find((candidate) => candidate.bars === horizonBarsValue);
            if (!horizon || !isUsableArchiveHorizon(horizon)) continue;
            values.push(toHorizonObservation(horizon));
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

/**
 * Per-sort worst-strategy counterfactual. For each archive sort, find the worst
 * strategy WITHIN that sort's selected rows (by primary horizon) and report the
 * before/after of excluding it. Reuses the same horizon-analysis and strategy-
 * performance builders as the pooled version, scoped to one sortMetric at a time.
 */
function buildOosWithoutWorstStrategyPerSort(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    horizonBars: number[],
): OosStrategyRemovalPerSortItem[] {
    const primaryHorizon = horizonBars.includes(12) ? 12 : horizonBars[0] ?? 0;
    const sortMetrics = [...new Set(records.map((record) => record.sortMetric))].sort();
    const items: OosStrategyRemovalPerSortItem[] = [];
    for (const sortMetric of sortMetrics) {
        const sortRecords = records.filter((record) => record.sortMetric === sortMetric);
        const strategyPerformance = buildStrategyPerformance(sortRecords, topK, horizonBars);
        const candidates = strategyPerformance
            .map((strategy) => ({
                strategy,
                average: strategy.horizons.find((horizon) => horizon.horizonBars === primaryHorizon)?.averagePnlPercent ?? null,
            }))
            .filter((value): value is { strategy: StrategyPerformanceAnalysis; average: number } => value.average !== null);
        const worst = [...candidates].sort((left, right) => left.average - right.average || left.strategy.strategyId.localeCompare(right.strategy.strategyId))[0];
        if (!worst) continue;
        items.push({
            sortMetric,
            removedStrategyId: worst.strategy.strategyId,
            removedStrategyName: worst.strategy.strategyName,
            selectionHorizonBars: primaryHorizon,
            before: buildArchiveHorizonAnalyses(sortRecords, topK, horizonBars),
            after: buildArchiveHorizonAnalyses(sortRecords, topK, horizonBars, worst.strategy.strategyId),
        });
    }
    return items;
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
        values: Map<number, HorizonObservation[]>;
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
            if (!isUsableArchiveHorizon(horizon)) continue;
            const values = group.values.get(horizon.bars) ?? [];
            values.push(toHorizonObservation(horizon));
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

function buildNextExitSignalCandleHourPerformance(
    records: AssetOpportunityArchiveRecord[],
    topK: number,
    field: "signalCandleHourUtc" | "signalCandleHourJakarta",
): NextExitSignalCandleHourAnalysis[] {
    const groups = new Map<number, {
        rows: AssetOpportunityArchiveRow[];
        holdoutBars: Set<number>;
        strategyIds: Set<string>;
    }>();
    for (const { record, row } of archiveRows(records, topK)) {
        const hour = row[field];
        if (hour === null || hour === undefined) continue;
        const group = groups.get(hour) ?? {
            rows: [],
            holdoutBars: new Set<number>(),
            strategyIds: new Set<string>(),
        };
        group.rows.push(row);
        group.holdoutBars.add(record.holdoutBars);
        if (row.strategyId) group.strategyIds.add(row.strategyId);
        groups.set(hour, group);
    }
    return [...groups.entries()]
        .map(([hour, group]) => ({
            hour,
            holdoutBars: [...group.holdoutBars].sort((left, right) => left - right),
            strategyCount: group.strategyIds.size,
            ...calculateNextExitAnalysis(group.rows),
        }))
        .sort((left, right) => left.hour - right.hour);
}

export function analyzeAssetOpportunityArchive(
    records: AssetOpportunityArchiveRecord[],
    options: AnalyzeOptions = {},
): AssetOpportunityHoldoutAnalysisReport {
    if (records.length === 0) throw new Error("The archive contains no records");
    const selected = selectBatchRun(records, options.batchRunId, options.includeAllBatchRuns);
    const measurementModes = new Set(selected.records.map((record) => record.measurementMode === "next_exit" ? "next_exit" : "fixed_horizon"));
    if (measurementModes.size > 1) {
        throw new Error(`Selected batch runs contain mixed forward measurement modes: ${[...measurementModes].sort().join(", ")}`);
    }
    const measurementMode = measurementModes.has("next_exit") ? "next_exit" : "fixed_horizon";
    const calculationMode: HoldoutCalculationMode = options.calculationMode ?? "fixed_horizon";
    if (calculationMode === "hold_until_change" && measurementMode !== "fixed_horizon") {
        throw new Error("hold_until_change requires fixed-horizon archives; the selected batch runs measure next-exit outcomes instead.");
    }
    const topK = Math.max(1, Math.floor(options.topK ?? DEFAULT_TOP_K));
    // Re-base every forward outcome to one price basis before any aggregation
    // (including gain exclusion, which trims forwardOosPerformance) so all
    // downstream analysis stays basis-consistent.
    const horizonBasisSelection = options.horizonBasis && measurementMode === "fixed_horizon"
        ? selectForwardOosBasis(selected.records, options.horizonBasis, topK)
        : null;
    if (horizonBasisSelection) selected.records = horizonBasisSelection.records;
    const horizonBasisNotes: string[] = options.horizonBasis && measurementMode === "next_exit"
        ? [`--basis ${options.horizonBasis} has no effect on next-exit archives: next-exit outcomes replay the pair trade and are basis-independent.`]
        : horizonBasisSelection
            ? [
                `Forward horizon basis filter: ${options.horizonBasis}. ${horizonBasisSelection.counts.rowsFromPerBasisMap} row outcomes came from per-basis maps, ${horizonBasisSelection.counts.rowsFromLegacyMatch} from legacy single-basis rows, ${horizonBasisSelection.counts.rowsWithoutBasis} selected rows had no ${options.horizonBasis} measurement and contribute only selection metadata.`,
                ...(horizonBasisSelection.counts.baselinesDropped > 0
                    ? [`${horizonBasisSelection.counts.baselinesDropped} archive blocks could not be re-based to ${options.horizonBasis}; their all-candidate baseline comparisons are unavailable in this report.`]
                    : []),
            ]
            : [];
    const availableSortMetrics = new Set(selected.records.map((record) => record.sortMetric));
    const excludedRedundantSortMetrics = availableSortMetrics.has("netProfit") && availableSortMetrics.has("netProfitPercent")
        ? ["netProfit"]
        : [];
    const archiveMaximumRank = selected.records.filter(record => !excludedRedundantSortMetrics.includes(record.sortMetric))
        .reduce((maximum, record) => Math.max(maximum, ...record.topResults.map((row, index) => row.rank ?? index + 1)), 0);
    let excludedObservations = 0;
    if (options.excludeGains100) {
        selected.records = selected.records.map(record => {
            const countExclusion = !excludedRedundantSortMetrics.includes(record.sortMetric);
            // Select the original top K before removing outcomes: never promote
            // a lower-ranked candidate because a winner was excluded afterwards.
            const rows = measurementMode === "next_exit" ? record.topResults.slice(0, topK) : record.topResults;
            return {
                ...record,
                // Aggregate baselines cannot be accurately trimmed without the
                // individual outcomes of the full candidate pool.
                baseline: null,
                nextExitBaseline: null,
                topResults: measurementMode === "next_exit"
                    ? rows.filter(row => {
                        const pnl = row.nextExitOosPerformance?.pnlPercent;
                        const excluded = typeof pnl === "number" && Number.isFinite(pnl) && pnl >= 100;
                        if (excluded && countExclusion) excludedObservations += 1;
                        return !excluded;
                    })
                    : rows.map((row, index) => ({
                        ...row,
                        ...(row.forwardOosPerformance ? { forwardOosPerformance: {
                            ...row.forwardOosPerformance,
                            horizons: row.forwardOosPerformance.horizons?.map(horizon => {
                                if (horizon.averagePnlPercent === null || !Number.isFinite(horizon.averagePnlPercent)
                                    || horizon.averagePnlPercent < 100) return horizon;
                                if (countExclusion && index < topK && horizon.sampleSize > 0) excludedObservations += 1;
                                return { ...horizon, averagePnlPercent: null, sampleSize: 0 };
                            }),
                        } } : {}),
                    })),
            };
        });
    }
    const analysisRecords = selected.records.filter((record) => !excludedRedundantSortMetrics.includes(record.sortMetric));
    const recordsBySort = new Map<string, AssetOpportunityArchiveRecord[]>();
    for (const record of analysisRecords) {
        const list = recordsBySort.get(record.sortMetric) ?? [];
        list.push(record);
        recordsBySort.set(record.sortMetric, list);
    }
    const holdoutBars = [...selected.holdoutBars].sort((left, right) => left - right);
    const sortMetrics = [...new Set(analysisRecords.map((record) => record.sortMetric))].sort();
    const baselineHorizonBars = [...new Set(selected.records.flatMap((record) => record.baseline?.horizons.map((horizon) => horizon.bars) ?? []))]
        .sort((left, right) => left - right);
    const baseline = baselineHorizonBars
        .map((horizonBarsValue) => buildBaselineHorizonAnalysis(selected.records, horizonBarsValue))
        .filter((value): value is BaselineHorizonAnalysis => value !== null);
    const parameterFingerprintAvailable = selected.records.some((record) => record.topResults.some((row) => Boolean(row.candidateFingerprint)));
    const sorts: SortHoldoutAnalysis[] = measurementMode === "fixed_horizon"
        ? [...recordsBySort.values()]
            .sort((left, right) => left[0]!.sortMetric.localeCompare(right[0]!.sortMetric))
            .map((sortRecords) => buildSortAnalysis(sortRecords, topK, holdoutBars.length))
        : [];
    if (calculationMode === "hold_until_change") {
        for (const sort of sorts) {
            const sortRecords = recordsBySort.get(sort.sortMetric) ?? [];
            const tenures = buildHoldUntilChangeTenures(sortRecords);
            const hold = buildHoldUntilChangeHoldAnalysis(tenures);
            sort.holdUntilChange = {
                tenures,
                horizons: buildHoldUntilChangeHorizonAnalyses(sortRecords, tenures),
                ...(hold ? { hold } : {}),
            };
        }
    }
    const anyChainedHold = sorts.some((sort) => sort.holdUntilChange?.tenures.some((tenure) => tenure.holdReturnPercent !== null) === true);
    const nextExitSorts: NextExitSortAnalysis[] = measurementMode === "next_exit"
        ? [...recordsBySort.values()]
            .sort((left, right) => left[0]!.sortMetric.localeCompare(right[0]!.sortMetric))
            .map((sortRecords) => buildNextExitSortAnalysis(sortRecords, topK))
        : [];
    const thesisEvidenceNotes = measurementMode === "next_exit"
        ? buildThesisEvidenceNotes(nextExitSorts)
        : [];
    const crossSortAgreement = buildCrossSortAgreement(analysisRecords, topK, holdoutBars.length, sortMetrics.length);
    const parameterVariants = parameterFingerprintAvailable
        ? buildParameterVariantAnalysis(crossSortAgreement, holdoutBars.length, sortMetrics.length)
        : [];
    const horizonBars = [...new Set(sorts.flatMap((sort) => sort.horizons.map((horizon) => horizon.horizonBars)))]
        .sort((left, right) => left - right);
    const ongoingObservationTotal = sorts.reduce((total, sort) => total
        + sort.horizons.reduce((sum, horizon) => sum + horizon.ongoingRows, 0), 0);
    const strategyPerformance = measurementMode === "fixed_horizon"
        ? buildStrategyPerformance(analysisRecords, topK, horizonBars)
        : [];
    const oosWithoutWorstStrategy = measurementMode === "fixed_horizon"
        ? buildOosWithoutWorstStrategy(strategyPerformance, analysisRecords, topK, horizonBars)
        : null;
    const oosWithoutWorstStrategyPerSort = measurementMode === "fixed_horizon"
        ? buildOosWithoutWorstStrategyPerSort(analysisRecords, topK, horizonBars)
        : [];
    const signalCandleHoursAvailable = analysisRecords.some((record) => record.topResults.some((row) => (
        row.signalCandleHourUtc !== null && row.signalCandleHourUtc !== undefined
    ) || (
        row.signalCandleHourJakarta !== null && row.signalCandleHourJakarta !== undefined
    )));
    const nextExitSignalCandleHourPerformance = measurementMode === "next_exit" && signalCandleHoursAvailable
        ? {
            utc: buildNextExitSignalCandleHourPerformance(analysisRecords, topK, "signalCandleHourUtc"),
            jakarta: buildNextExitSignalCandleHourPerformance(analysisRecords, topK, "signalCandleHourJakarta"),
        }
        : { utc: [], jakarta: [] };
    // Measurement-contract segregation: one line per analyzed run lists the
    // distinct epoch values its blocks carry, and a warning fires when the
    // report pools blocks with differing or absent epochs.
    const epochRuns = [...selected.records.reduce((groups, record) => {
        const group = groups.get(record.batchRunId) ?? { batchRunId: record.batchRunId, epochs: new Set<string>(), blocksMissingEpoch: 0 };
        if (record.archiveEpoch) group.epochs.add(record.archiveEpoch);
        else group.blocksMissingEpoch += 1;
        groups.set(record.batchRunId, group);
        return groups;
    }, new Map<string, { batchRunId: string; epochs: Set<string>; blocksMissingEpoch: number }>()).values()]
        .map((group) => ({
            batchRunId: group.batchRunId,
            epochs: [...group.epochs].sort((left, right) => left.localeCompare(right)),
            blocksMissingEpoch: group.blocksMissingEpoch,
        }))
        .sort((left, right) => left.batchRunId.localeCompare(right.batchRunId));
    const mixedEpochWarning = (() => {
        const distinctEpochs = new Set(epochRuns.flatMap((run) => run.epochs));
        const anyMissing = epochRuns.some((run) => run.blocksMissingEpoch > 0);
        const runsWithMixed = epochRuns.filter((run) => run.epochs.length > 1);
        if (distinctEpochs.size <= 1 && !anyMissing && runsWithMixed.length === 0) return null;
        const parts: string[] = [];
        if (runsWithMixed.length > 0) {
            parts.push(`runs mixing epochs: ${runsWithMixed.map((run) => `${run.batchRunId} [${run.epochs.join(", ")}]`).join("; ")}`);
        }
        if (anyMissing) {
            parts.push(`${epochRuns.reduce((sum, run) => sum + run.blocksMissingEpoch, 0)} blocks carry no epoch (legacy/unknown measurement contract)`);
        }
        if (distinctEpochs.size > 1) {
            parts.push(`report epochs: ${[...distinctEpochs].sort((left, right) => left.localeCompare(right)).join(", ")}`);
        }
        return `WARNING: pooled blocks differ in measurement contract (${parts.join("; ")}). Segregate runs by epoch before comparing picks across contracts.`;
    })();
    const poolDistributionBlocks = analysisRecords.filter((record) => record.poolDistribution !== null).length;
    return {
        schemaVersion: REPORT_SCHEMA_VERSION,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        archiveDirectory: options.archiveDirectory ?? "",
        selectedBatchRunId: selected.batchRunId,
        selectedBatchRunIds: selected.batchRunIds,
        selectedBatchRunLatestTimestamp: selected.latestTimestamp,
        excludedBatchRunIds: selected.excludedBatchRunIds,
        holdoutBars,
        sourceBlockCount: records.length,
        selectedBlockCount: selected.records.length,
        analyzedBlockCount: analysisRecords.length,
        measurementMode,
        calculationMode,
        ...(options.horizonBasis ? { horizonBasis: options.horizonBasis } : {}),
        ...(options.excludeGains100 ? { gainExclusion: { thresholdPercent: 100, excludedObservations } } : {}),
        excludedRedundantSortMetrics,
        topK,
        archiveMaximumRank,
        candidateIdentity: parameterFingerprintAvailable
            ? "symbol+strategyId+candidateFingerprint"
            : "symbol+strategyId",
        parameterFingerprintAvailable,
        baselineAvailable: baseline.length > 0,
        baseline,
        epochRuns,
        mixedEpochWarning,
        poolDistributionBlocks,
        nextExit: measurementMode === "next_exit"
            ? {
                baseline: buildNextExitBaselineAnalysis(selected.records),
                sorts: nextExitSorts,
                signalCandleHourPerformance: nextExitSignalCandleHourPerformance,
            }
            : null,
        questionsAnswered: measurementMode === "next_exit"
            ? [...NEXT_EXIT_REPORT_QUESTIONS]
            : [...REPORT_QUESTIONS],
        notes: [
            ...(options.excludeGains100 ? [
                "Robustness sensitivity check: exclude forward gains >= +100%, keep losses unchanged, and never replace excluded top-K picks. This outcome-based exclusion is not a live trading rule.",
                "Fixed-horizon exclusions apply independently per row/horizon; other horizons and historical selection metadata remain intact. Next-exit exclusions remove outcomes from the original top K before aggregation.",
                "All-candidate baseline and deltas are unavailable in this variant: archived aggregate baselines cannot be filtered without individual candidate outcomes.",
            ] : []),
            ...horizonBasisNotes,
            ...(calculationMode === "hold_until_change" ? [
                "Hold-until-change mode: each sort is walked chronologically (descending holdout bars); the rank-1 asset is entered the first boundary it appears and held until the rank-1 pick changes to a different symbol, so a leader held for N boundaries contributes once instead of N overlapping times. Requested top-K is ignored; only rank-1 rows are measured.",
                "The printed summary shows only the entry→exit hold return; per-horizon tenure-entry outcomes stay in the JSON under sorts[].holdUntilChange.horizons. Without the 1-bar horizon in the archive the hold return cannot be chained, and switching costs are not applied.",
                ...(anyChainedHold ? [
                    "entry→exit returns chain the archive's 1-bar horizon across the held boundaries. The 1-bar value is measured from the run's entry price (first hidden bar), so under next-open/next-close entry the chain omits each close→open gap between bars: short holds are close to exact, but a tenure spanning a session gap (roughly every 13 bars on 30m charts) is approximate. The chain itself is exact under signal_close entry.",
                ] : []),
                "Sections other than the hold-until-change summary and leader path remain per-boundary overlapping fixed-horizon diagnostics.",
            ] : []),
            "Forward OOS metrics are descriptive evidence, not a trading rule or probability.",
            "Holdout values are overlapping/nested windows and must not be treated as independent experiments.",
            ...(selected.batchRunIds.length > 1
                ? ["Archive blocks from all batch runs were combined; when the same holdout and sort appears more than once, only its latest block is analyzed."]
                : []),
            parameterFingerprintAvailable
                ? "Candidate fingerprints include entry and optional exit parameters; they are reproducibility keys, not security hashes."
                : "No parameter fingerprints are present in the selected archive; candidate persistence is symbol+strategyId only.",
            measurementMode === "next_exit"
                ? "Next-exit PnL uses only observed exits; censored and unavailable rows are reported separately and are not treated as zero PnL."
                : options.excludeGains100
                    ? "The filtered report does not compare selected outcomes with the unfiltered archived baseline."
                    : baseline.length > 0
                    ? "The all-candidate baseline uses every result row before the top-N archive slice; it is not a random-trade simulation."
                    : "The all-candidate baseline is unavailable because older archive blocks contain only top-N rows.",
            ...(measurementMode === "fixed_horizon"
                ? [
                    ...(calculationMode === "fixed_horizon"
                        ? ["Per-sort all-candidate averages and deltas use holdouts with at least one valid selected-row forward sample."]
                        : []),
                    "Samples count valid selected-row forward observations. Fresh entries use their forward metric; an OPEN EOD row uses continuation from the holdout boundary close in the existing position direction.",
                    ...(ongoingObservationTotal > 0
                        ? [`${ongoingObservationTotal} forward observations were ongoing: the horizon exceeded the holdout, so the return is measured at the last available candle (mark-to-market), not at the full horizon. Aggregates use completed horizons only; the Ongoing columns report the separate mark-to-market stats for horizons the sweep has not reached yet.`]
                        : []),
                    "OPEN EOD continuation is an evaluation measurement from the boundary close, not a claim that a new signal or order occurred. Coverage shows valid observations over selected top-K rows.",
                    "Older archives without forward metrics for OPEN EOD rows cannot contribute those rows; rerun Finder to archive the unified measurement.",
                ]
                : []),
            ...(excludedRedundantSortMetrics.length > 0
                ? ["netProfit was omitted from the detailed analysis because it duplicates netProfitPercent in the selected archive."]
                : []),
            ...(archiveMaximumRank > 0 && topK > archiveMaximumRank
                ? [`Requested top-K ${topK} exceeds the archive maximum rank ${archiveMaximumRank}; no rows beyond rank ${archiveMaximumRank} can be measured.`]
                : []),
            measurementMode === "next_exit"
                ? "Each archive sort is analyzed independently; holdout bars are the maximum observation window, not a fixed exit horizon."
                : "Each archive sort and forward horizon is analyzed independently; freshSignalLibraries is not pooled with performance sorts.",
            "The JSON report stores each candidate's per-holdout series; aggregate rows must not be treated as independent samples.",
            "Strategy contribution and worst-strategy removal are calculated from archived selected rows; removal does not rerun Finder or simulate capital, position sizing, or trade overlap.",
            ...(measurementMode === "next_exit"
                ? [
                    "The thesis audit uses all archived shortlist rows per holdout, not only the requested outcome top-K; varied compares rank 1 with rank 2. It does not reconstruct the full candidate pool.",
                    "If a thesis is unavailable, insufficient, degenerate, or not testable within the archived shortlist, its rank-1 result can include deterministic tiebreak selection and is not clean evidence for that thesis.",
                    ...thesisEvidenceNotes,
                ]
                : []),
            ...(poolDistributionBlocks > 0
                ? [
                    "Pool P50 / P10–P90 columns read the archived pool distribution (nearest-rank percentiles over the retained candidate pool). Percentiles add robust location and tails only: they do NOT reconstruct trimmed means, so --exclude-gains-100 baselines remain unavailable.",
                ]
                : []),
            ...(mixedEpochWarning ? [mixedEpochWarning] : []),
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
        oosWithoutWorstStrategyPerSort,
        signalCandleHoursAvailable,
        signalCandleHourPerformance: {
            utc: signalCandleHoursAvailable && measurementMode === "fixed_horizon"
                ? buildSignalCandleHourPerformance(analysisRecords, topK, horizonBars, "signalCandleHourUtc")
                : [],
            jakarta: signalCandleHoursAvailable && measurementMode === "fixed_horizon"
                ? buildSignalCandleHourPerformance(analysisRecords, topK, horizonBars, "signalCandleHourJakarta")
                : [],
        },
    };
}

function formatNumber(value: number | null, digits = 2): string {
    return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function formatHoldoutWindows(values: number[]): string {
    const sorted = [...new Set(values)].sort((left, right) => left - right);
    if (sorted.length === 0) return "n/a";
    const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1]! + 1);
    let label: string;
    if (sorted.length === 1) {
        label = String(sorted[0]);
    } else if (contiguous) {
        label = `${sorted[0]}–${sorted[sorted.length - 1]}`;
    } else {
        label = sorted.join(", ");
    }
    return `${label} (${sorted.length})`;
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

function renderHorizonColumnHeader(horizonColumns: number[]): string {
    return horizonColumns.map((bars) => `${bars}-bar avg/positive`).join(" | ");
}

function renderHorizonColumnCells(horizonColumns: number[], renderCell: (bars: number) => string): string[] {
    return horizonColumns.map((bars) => renderCell(bars));
}

function renderSignalCandleHourSection(
    lines: string[],
    label: string,
    hours: SignalCandleHourAnalysis[],
    primaryHorizonBars: number,
    horizonColumns: number[],
): void {
    lines.push("", `SIGNAL CANDLE HOUR — ${label} (best/worst by ${primaryHorizonBars}-bar average)`);
    if (hours.length === 0) {
        lines.push("Unavailable: new archive rows must contain signalCandleHourUtc/signalCandleHourJakarta.");
        return;
    }
    lines.push(`Hour | Occurrences | Holdouts | Strategies | ${renderHorizonColumnHeader(horizonColumns)}`);
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
            ...renderHorizonColumnCells(horizonColumns, (bars) => formatAnalysisHorizon(hour.horizons.find((horizon) => horizon.horizonBars === bars))),
        ].join(" | "));
    }
    lines.push("Full hour breakdown is stored in JSON under signalCandleHourPerformance.");
}

function primaryCandidateHorizon(sort: SortHoldoutAnalysis): number {
    return sort.horizons.some((horizon) => horizon.horizonBars === 12)
        ? 12
        : sort.horizons[0]?.horizonBars ?? 0;
}

function formatExitReasonCounts(exitReasonCounts: Record<string, number>): string {
    const entries = Object.entries(exitReasonCounts).sort(([left], [right]) => left.localeCompare(right));
    return entries.length > 0 ? entries.map(([reason, count]) => `${reason}=${count}`).join(", ") : "none";
}

function formatThesisSortEvidence(evidence: ThesisSortEvidence): string {
    if (evidence.status === "control") return "control (no single thesis metric)";
    if (evidence.status === "not_persisted") return "thesis value not archived";
    const recurrence = evidence.positiveRows === null
        ? ""
        : `, recurring=${evidence.positiveRows}/${evidence.validRows}`;
    const status = evidence.status.toUpperCase().replace("_", " ");
    return `${evidence.validRows}/${evidence.totalRows} valid${recurrence}, varied=${evidence.differentiatedHoldouts}/${evidence.comparableHoldouts} comparable holdouts, distinct=${evidence.distinctValues} (${status})`;
}

function buildThesisEvidenceNotes(
    sorts: ReadonlyArray<{ sortMetric: string; thesisMetricEvidence: ThesisSortEvidence }>,
): string[] {
    return sorts
        .filter((sort) => sort.thesisMetricEvidence.status === "unavailable"
            || sort.thesisMetricEvidence.status === "insufficient_data"
            || sort.thesisMetricEvidence.status === "degenerate"
            || sort.thesisMetricEvidence.status === "not_testable"
            || sort.thesisMetricEvidence.status === "not_persisted")
        .map((sort) => `${sort.sortMetric} has ${formatThesisSortEvidence(sort.thesisMetricEvidence)}; its rank-1 result cannot establish that this thesis chose the winner rather than a tiebreak.`);
}

function renderNextExitSignalCandleHourSection(
    lines: string[],
    label: string,
    hours: NextExitSignalCandleHourAnalysis[],
    baselineAveragePnlPercent: number | null,
): void {
    lines.push("", `NEXT-EXIT SIGNAL CANDLE HOUR — ${label} (selected rows; best/worst by observed average PnL)`);
    if (hours.length === 0) {
        lines.push("Unavailable: archive rows do not contain this signal-candle hour field.");
        return;
    }
    lines.push("Hour | Rows | Holdouts | Strategies | Exits | Positive exits | Censored | Unavailable | Avg PnL | Median PnL | P10 PnL | Worst PnL | Delta vs baseline");
    const ranked = [...hours].sort((left, right) => {
        return (right.averagePnlPercent ?? Number.NEGATIVE_INFINITY)
            - (left.averagePnlPercent ?? Number.NEGATIVE_INFINITY)
            || right.observedRows - left.observedRows
            || left.hour - right.hour;
    });
    const selected = [...ranked.slice(0, 3), ...ranked.slice(-3)]
        .filter((hour, index, all) => all.findIndex((candidate) => candidate.hour === hour.hour) === index);
    for (const hour of selected) {
        const delta = hour.averagePnlPercent !== null && baselineAveragePnlPercent !== null
            ? hour.averagePnlPercent - baselineAveragePnlPercent
            : null;
        lines.push([
            `${String(hour.hour).padStart(2, "0")}:00`,
            String(hour.totalRows),
            String(hour.holdoutBars.length),
            String(hour.strategyCount),
            `${hour.observedRows}/${hour.totalRows}`,
            `${hour.positiveRows}/${hour.observedRows}`,
            String(hour.censoredRows),
            String(hour.unavailableRows),
            formatPercent(hour.averagePnlPercent),
            formatPercent(hour.medianPnlPercent),
            formatPercent(hour.p10PnlPercent),
            formatPercent(hour.worstPnlPercent),
            formatPercent(delta),
        ].join(" | "));
    }
    lines.push("Rows can repeat across archive sorts; use this as a concentration diagnostic, not as independent hour trials. Full hour data is stored in JSON.");
}

function renderNextExitReport(
    report: AssetOpportunityHoldoutAnalysisReport,
    headerLines: string[],
): string {
    const lines = [
        ...headerLines,
        "",
        DISCOVERY_WARNING,
        "Interpretation: next-exit results are descriptive evidence only. Censored and unavailable outcomes are not zero-PnL exits.",
        "Thesis audit: valid/distinct use every archived shortlist row; varied compares rank 1 with rank 2 in each holdout. It is independent of outcome top-K and does not contain the full candidate-pool distribution.",
        "Unavailable reasons: no_boundary_trade means no exact entry matched; missing_exit_reason means a trade matched without an exit reason; replay_error means the full replay failed; unknown_legacy means the archive predates this diagnostic.",
        "",
        "QUESTIONS ANSWERED BY THIS REPORT",
        ...report.questionsAnswered.map((question, index) => `${index + 1}. ${question}`),
        "",
        "NEXT EXIT OOS SUMMARY — BEST TO WORST BY OBSERVED AVG PNL",
        "Sort | Thesis audit (archived shortlist) | Holdout coverage | Exits | Positive exits | Censored | Unavailable | Unavailable reasons | Avg PnL | Median PnL | P10 PnL | Worst PnL | Avg bars held | Exit reasons | Delta vs baseline",
    ];
    const baselineAverage = report.nextExit?.baseline?.averagePnlPercent ?? null;
    const orderedSorts = [...(report.nextExit?.sorts ?? [])].sort((left, right) => {
        return (right.averagePnlPercent ?? Number.NEGATIVE_INFINITY) - (left.averagePnlPercent ?? Number.NEGATIVE_INFINITY)
            || (right.positiveRatePercent ?? Number.NEGATIVE_INFINITY) - (left.positiveRatePercent ?? Number.NEGATIVE_INFINITY)
            || right.observedRows - left.observedRows
            || left.sortMetric.localeCompare(right.sortMetric);
    });
    for (const sort of orderedSorts) {
        const delta = sort.averagePnlPercent !== null && baselineAverage !== null
            ? sort.averagePnlPercent - baselineAverage
            : null;
        lines.push([
            sort.sortMetric,
            formatThesisSortEvidence(sort.thesisMetricEvidence),
            `${sort.holdoutBars.length}/${report.holdoutBars.length}`,
            `${sort.observedRows}/${sort.totalRows}`,
            `${sort.positiveRows}/${sort.observedRows}`,
            String(sort.censoredRows),
            String(sort.unavailableRows),
            formatExitReasonCounts(sort.unavailableReasonCounts),
            formatPercent(sort.averagePnlPercent),
            formatPercent(sort.medianPnlPercent),
            formatPercent(sort.p10PnlPercent),
            formatPercent(sort.worstPnlPercent),
            formatNumber(sort.averageBarsHeld),
            formatExitReasonCounts(sort.exitReasonCounts),
            formatPercent(delta),
        ].join(" | "));
    }
    if ((report.nextExit?.sorts.length ?? 0) === 0) {
        lines.push("Unavailable: no selected top-K next-exit rows were found.");
    }
    lines.push(
        "",
        "ALL-CANDIDATE NEXT-EXIT BASELINE",
    );
    const baseline = report.nextExit?.baseline;
    if (!baseline) {
        lines.push("Unavailable: archive blocks do not contain a next-exit baseline.");
    } else {
        lines.push("Holdouts | Avg eligible candidates | Observed exits | Censored | Unavailable | Unavailable reasons | Avg PnL | Exit reasons");
        lines.push([
            String(baseline.observedHoldouts),
            formatNumber(baseline.averageEligibleCandidateCount),
            String(baseline.observedExits),
            String(baseline.censoredResults),
            String(baseline.unavailableResults),
            formatExitReasonCounts(baseline.unavailableReasonCounts),
            formatPercent(baseline.averagePnlPercent),
            formatExitReasonCounts(baseline.exitReasonCounts),
        ].join(" | "));
    }
    if (report.signalCandleHoursAvailable) {
        renderNextExitSignalCandleHourSection(
            lines,
            "UTC",
            report.nextExit?.signalCandleHourPerformance.utc ?? [],
            baselineAverage,
        );
        renderNextExitSignalCandleHourSection(
            lines,
            "Asia/Jakarta",
            report.nextExit?.signalCandleHourPerformance.jakarta ?? [],
            baselineAverage,
        );
    } else {
        lines.push("", "NEXT-EXIT SIGNAL CANDLE HOUR");
        lines.push("Unavailable: legacy archive rows do not contain signal candle hour fields.");
    }
    lines.push(
        "",
        "Selection persistence and concentration diagnostics are available in the JSON report; their repeated holdout/sort appearances are not independent observations.",
        "Excluded batch runs: " + (report.excludedBatchRunIds.length > 0 ? report.excludedBatchRunIds.join(", ") : "none"),
    );
    for (const note of report.notes) lines.push(`- ${note}`);
    return `${lines.join("\n")}\n`;
}

/**
 * One `|`-joined row of the "selection concentration by symbol" and "by
 * strategy" tables. Both tables share this exact row shape, so a single owner
 * keeps the two sections from silently drifting apart.
 */
function formatSelectionConcentrationRow(
    group: SelectionConcentrationAnalysis,
    report: AssetOpportunityHoldoutAnalysisReport,
): string {
    return [
        group.key,
        String(group.distinctCandidates),
        `${group.holdoutBars.length}/${report.holdoutBars.length} (${formatPercent(group.holdoutCoveragePercent)})`,
        `${group.sortMetrics.length}/${report.sorts.length} (${formatPercent(group.sortCoveragePercent)})`,
        String(group.appearances),
        String(group.topRankAppearances),
    ].join(" | ");
}

export function renderAssetOpportunityHoldoutReport(report: AssetOpportunityHoldoutAnalysisReport): string {
    const headerLines: string[] = [
        "Asset Opportunity Holdout Evidence Report",
        "===========================================",
        `Generated: ${report.generatedAt}`,
        report.selectedBatchRunId
            ? `Selected batch run: ${report.selectedBatchRunId}`
            : `Selected batch runs: ${report.selectedBatchRunIds.join(", ")}`,
        `Holdout windows: ${formatHoldoutWindows(report.holdoutBars)}`,
        `Archive blocks analyzed: ${report.analyzedBlockCount} of ${report.selectedBlockCount} selected (${report.sourceBlockCount} source)`,
        `Forward measurement: ${report.measurementMode}`,
        ...(report.calculationMode === "hold_until_change"
            ? ["Calculation mode: hold_until_change (non-overlapping rank-1 leader tenures)"]
            : []),
        ...(report.horizonBasis ? [`Forward horizon basis: ${report.horizonBasis}`] : []),
        ...(report.gainExclusion ? [
            `Gain exclusion: >= +${report.gainExclusion.thresholdPercent}% (excluded ${report.gainExclusion.excludedObservations} top-K observations across analyzed sort blocks; no replacements)`,
        ] : []),
        `Outcome rows: cumulative ranks 1–${report.topK} requested (archive maximum rank: ${report.archiveMaximumRank || "none"})`,
        `Candidate identity: ${report.candidateIdentity}`,
        `Parameter fingerprints: ${report.parameterFingerprintAvailable ? "available" : "not available in this archive"}`,
        `All-candidate baseline: ${report.gainExclusion ? "unavailable after gain exclusion (only aggregates archived)" : report.baselineAvailable || report.nextExit?.baseline ? "available" : "not available in this archive"}`,
        `Pool distribution: ${report.poolDistributionBlocks > 0 ? `available in ${report.poolDistributionBlocks} analyzed blocks` : "not available in this archive"}`,
        ...report.epochRuns.map((run) => `Archive epoch (${run.batchRunId}): ${run.epochs.length > 0 ? run.epochs.join(", ") : "none (legacy/unknown)"}${run.blocksMissingEpoch > 0 ? ` · ${run.blocksMissingEpoch} blocks without an epoch` : ""}`),
    ];
    if (report.measurementMode === "next_exit") {
        return renderNextExitReport(report, headerLines);
    }
    const lines: string[] = [
        ...headerLines,
        "",
        DISCOVERY_WARNING,
        "Interpretation: forward OOS results are descriptive evidence only. Holdout windows overlap, so positive percentages are not independent predictive probabilities.",
        "",
        "QUESTIONS ANSWERED BY THIS REPORT",
        ...report.questionsAnswered.map((question, index) => `${index + 1}. ${question}`),
    ];
    const holdUntilChangeMode = report.calculationMode === "hold_until_change";
    const holdStepStats = (sort: SortHoldoutAnalysis): { average: number | null; longest: number | null } => {
        const tenures = sort.holdUntilChange?.tenures ?? [];
        return {
            average: tenures.length > 0
                ? tenures.reduce((sum, tenure) => sum + tenure.tenureSteps, 0) / tenures.length
                : null,
            longest: tenures.length > 0 ? Math.max(...tenures.map((tenure) => tenure.tenureSteps)) : null,
        };
    };
    const mode1HorizonBars = [...new Set(report.sorts.flatMap((sort) => sort.horizons.map((horizon) => horizon.horizonBars)))]
        .sort((left, right) => left - right);
    // Horizon 1 exists as the chaining step for hold-until-change, not as a
    // strategy horizon: keep it out of primary-horizon selection when longer
    // horizons are present.
    const primarySummaryHorizon = mode1HorizonBars.includes(12)
        ? 12
        : mode1HorizonBars.filter((bars) => bars > 1)[0] ?? mode1HorizonBars[0] ?? 0;
    const orderedSorts = holdUntilChangeMode
        ? [...report.sorts].sort((left, right) => {
            return (right.holdUntilChange?.hold?.averagePnlPercent ?? Number.NEGATIVE_INFINITY)
                - (left.holdUntilChange?.hold?.averagePnlPercent ?? Number.NEGATIVE_INFINITY)
                || (right.holdUntilChange?.hold?.positiveRatePercent ?? Number.NEGATIVE_INFINITY)
                    - (left.holdUntilChange?.hold?.positiveRatePercent ?? Number.NEGATIVE_INFINITY)
                || left.sortMetric.localeCompare(right.sortMetric);
        })
        : [...report.sorts].sort((left, right) => {
            return (analysisHorizonValue(right, primarySummaryHorizon) ?? Number.NEGATIVE_INFINITY)
                - (analysisHorizonValue(left, primarySummaryHorizon) ?? Number.NEGATIVE_INFINITY)
                || (right.horizons.find((horizon) => horizon.horizonBars === primarySummaryHorizon)?.positiveRatePercent ?? Number.NEGATIVE_INFINITY)
                    - (left.horizons.find((horizon) => horizon.horizonBars === primarySummaryHorizon)?.positiveRatePercent ?? Number.NEGATIVE_INFINITY)
                || left.sortMetric.localeCompare(right.sortMetric);
        });
    if (holdUntilChangeMode) {
        lines.push(
            "",
            "HOLD-UNTIL-CHANGE OOS SUMMARY — BEST TO WORST BY ENTRY→EXIT AVG PNL",
            "Sort | Positive trades | Average PnL | Median PnL | P10 PnL | Worst PnL | Ongoing n | Ongoing avg | Avg hold steps | Longest hold | Samples (completed)",
        );
        const holdSorts = orderedSorts.filter((sort) => sort.holdUntilChange?.hold);
        if (holdSorts.length === 0) {
            lines.push("Unavailable: the archive has no usable 1-bar horizon, so entry→exit holds cannot be chained. Set OOS Horizons to include 1 and rerun the sweep.");
        }
        for (const sort of holdSorts) {
            const holdAnalysis = sort.holdUntilChange!.hold!;
            const steps = holdStepStats(sort);
            lines.push([
                sort.sortMetric,
                `${holdAnalysis.positiveRows}/${holdAnalysis.observedRows}`,
                formatPercent(holdAnalysis.averagePnlPercent),
                formatPercent(holdAnalysis.medianPnlPercent),
                formatPercent(holdAnalysis.p10PnlPercent),
                formatPercent(holdAnalysis.worstPnlPercent),
                String(holdAnalysis.ongoingRows),
                formatPercent(holdAnalysis.ongoingAveragePnlPercent),
                formatNumber(steps.average),
                String(steps.longest),
                String(holdAnalysis.totalSamples),
            ].join(" | "));
        }
        lines.push("", "HOLD-UNTIL-CHANGE LEADER PATH (chronological; entry holdout descending = forward in time)");
        lines.push("Sort | Leader | Strategy | Entry holdout | Exit holdout | Steps | Hold PnL (entry→exit)");
        for (const sort of orderedSorts) {
            for (const tenure of sort.holdUntilChange?.tenures ?? []) {
                lines.push([
                    sort.sortMetric,
                    tenure.symbol,
                    tenure.strategyId,
                    String(tenure.entryHoldoutBars),
                    tenure.exitHoldoutBars === null ? "held" : String(tenure.exitHoldoutBars),
                    String(tenure.tenureSteps),
                    formatPercent(tenure.holdReturnPercent),
                ].join(" | "));
            }
        }
    } else {
        lines.push(
            "",
            "FORWARD OOS SUMMARY — BEST TO WORST BY PRIMARY HORIZON AVG PNL",
            "Sort | Horizon | Positive rows | Average PnL | Median PnL | P10 PnL | Worst PnL | Matched all-candidate avg | Pool P50 | Pool P10–P90 | Delta | Ongoing n | Ongoing avg | Samples (completed)",
        );
        for (const sort of orderedSorts) {
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
                    formatPercent(horizon.poolP50PnlPercent),
                    horizon.poolP10PnlPercent !== null && horizon.poolP90PnlPercent !== null
                        ? `${formatPercent(horizon.poolP10PnlPercent)} – ${formatPercent(horizon.poolP90PnlPercent)}`
                        : formatPercent(null),
                    formatPercent(delta),
                    String(horizon.ongoingRows),
                    formatPercent(horizon.ongoingAveragePnlPercent),
                    String(horizon.totalSamples),
                ].join(" | "));
            }
        }
    }
    const horizonColumns = [...new Set(report.sorts.flatMap((sort) => sort.horizons.map((horizon) => horizon.horizonBars)))].sort((left, right) => left - right).slice(0, 3);
    lines.push("", "STRATEGY LIBRARY FORWARD OOS CONTRIBUTION (selected top rows; sorted by primary-horizon average)");
    lines.push(`Strategy | Occurrences | Holdouts | Sorts | ${renderHorizonColumnHeader(horizonColumns)}`);
    for (const strategy of report.strategyPerformance) {
        lines.push([
            strategy.strategyId,
            String(strategy.occurrences),
            String(strategy.holdoutBars.length),
            String(strategy.sortMetrics.length),
            ...renderHorizonColumnCells(horizonColumns, (bars) => formatAnalysisHorizon(strategy.horizons.find((horizon) => horizon.horizonBars === bars))),
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
    lines.push("", "OOS COUNTERFACTUAL — REMOVE WORST STRATEGY BY SORT (per-sort row exclusion; not a rerun)");
    if (report.oosWithoutWorstStrategyPerSort.length === 0) {
        lines.push("Unavailable: no sort has a finite per-strategy forward OOS average.");
    } else {
        const perSortHorizon = report.oosWithoutWorstStrategyPerSort[0]!.selectionHorizonBars;
        lines.push(`Worst strategy per sort by ${perSortHorizon}-bar average (within that sort's selected rows). Change = after − before.`);
        lines.push(`Sort | Worst strategy | ${perSortHorizon}-bar before | ${perSortHorizon}-bar after | Change`);
        for (const item of report.oosWithoutWorstStrategyPerSort) {
            const before = item.before.find((horizon) => horizon.horizonBars === item.selectionHorizonBars);
            const after = item.after.find((horizon) => horizon.horizonBars === item.selectionHorizonBars);
            const change = before?.averagePnlPercent != null && after?.averagePnlPercent != null
                ? after.averagePnlPercent - before.averagePnlPercent
                : null;
            lines.push([
                item.sortMetric,
                item.removedStrategyId,
                `${formatAnalysisHorizon(before)} (${before?.observedRows ?? 0} rows)`,
                `${formatAnalysisHorizon(after)} (${after?.observedRows ?? 0} rows)`,
                formatPercent(change),
            ].join(" | "));
        }
    }
    const primaryHorizonBars = report.sorts.some((sort) => sort.horizons.some((horizon) => horizon.horizonBars === 12)) ? 12 : report.sorts[0]?.horizons[0]?.horizonBars ?? 0;
    if (report.signalCandleHoursAvailable) {
        renderSignalCandleHourSection(lines, "UTC", report.signalCandleHourPerformance.utc, primaryHorizonBars, horizonColumns);
        renderSignalCandleHourSection(lines, "Asia/Jakarta", report.signalCandleHourPerformance.jakarta, primaryHorizonBars, horizonColumns);
    } else {
        lines.push("", "SIGNAL CANDLE HOUR");
        lines.push("Unavailable: legacy archive rows do not contain signal candle hour fields. New batches will report UTC and Asia/Jakarta hours.");
    }
    lines.push("", `PERSISTENT CANDIDATES (one row per candidate; top ${DEFAULT_REPORT_CANDIDATES} by coverage, then ${primaryHorizonBars}-bar OOS consistency)`);
    for (const sort of report.sorts) {
        lines.push("", `Sort: ${sort.sortMetric}`);
        lines.push(`Candidate | Coverage | Top 3% | Median rank | Longest run | ${renderHorizonColumnHeader(horizonColumns)} | All horizons positive`);
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
                ...renderHorizonColumnCells(horizonColumns, (bars) => formatCandidateHorizon(candidate, bars)),
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
        lines.push(formatSelectionConcentrationRow(group, report));
    }
    lines.push("", "SELECTION CONCENTRATION BY STRATEGY (not a pooled performance estimate)");
    lines.push("Strategy | Candidate variants | Holdout coverage | Sort coverage | Appearances | Top 3 appearances");
    for (const group of report.strategyConcentration.slice(0, DEFAULT_REPORT_CANDIDATES)) {
        lines.push(formatSelectionConcentrationRow(group, report));
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

export function colorizeAssetOpportunityHoldoutReport(
    reportText: string,
    useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
): string {
    if (!useColor) return reportText;
    const cyan = "\u001b[96m";
    const green = "\u001b[92m";
    const red = "\u001b[91m";
    const yellow = "\u001b[93m";
    const reset = "\u001b[0m";
    const sectionPattern = /^(QUESTIONS ANSWERED|NEXT EXIT OOS SUMMARY|NEXT-EXIT SIGNAL CANDLE HOUR|ALL-CANDIDATE NEXT-EXIT BASELINE|FORWARD OOS SUMMARY|HOLD-UNTIL-CHANGE|STRATEGY LIBRARY|OOS COUNTERFACTUAL|SIGNAL CANDLE HOUR|PERSISTENT CANDIDATES|CROSS-SORT AGREEMENT|SELECTION CONCENTRATION|PARAMETER FINGERPRINT)/;
    return reportText.split("\n").map((line) => {
        const coloredLine = line.replace(/[-+]?\d+(?:\.\d+)?%/g, (match) => {
            const value = Number.parseFloat(match);
            const color = value > 0 ? green : value < 0 ? red : yellow;
            return `${color}${match}${reset}`;
        });
        return sectionPattern.test(line.trim())
            ? `${cyan}${coloredLine}${reset}`
            : coloredLine;
    }).join("\n");
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
    const requestedBasis = getArgument(process.argv.slice(2), "--basis");
    const horizonBasis = HORIZON_BASES.find((basis) => basis === requestedBasis);
    if (requestedBasis !== undefined && !horizonBasis) {
        console.error(`[asset-opportunity-holdouts] Invalid --basis "${requestedBasis}". Use one of: ${HORIZON_BASES.join(", ")}.`);
        process.exitCode = 1;
        return;
    }
    const requestedMode = getArgument(process.argv.slice(2), "--mode");
    const calculationMode = CALCULATION_MODES.find((mode) => mode === requestedMode);
    if (requestedMode !== undefined && !calculationMode) {
        console.error(`[asset-opportunity-holdouts] Invalid --mode "${requestedMode}". Use one of: ${CALCULATION_MODES.join(", ")}.`);
        process.exitCode = 1;
        return;
    }
    try {
        // Fixed-horizon aggregation reads only the first top-K rows of each
        // block, so capping full-row parsing at top-K keeps archive-wide heap
        // flat as sweeps accumulate; stub rows preserve the all-row rank,
        // fingerprint, and signal-hour availability checks.
        const records = readAssetOpportunityArchive(archiveDirectory, { maxFullRows: topK });
        const report = analyzeAssetOpportunityArchive(records, {
            archiveDirectory,
            batchRunId: requestedBatchRunId,
            includeAllBatchRuns: requestedBatchRunId === undefined,
            topK,
            ...(horizonBasis ? { horizonBasis } : {}),
            calculationMode,
            excludeGains100: process.argv.includes("--exclude-gains-100"),
        });
        const renderedReport = renderAssetOpportunityHoldoutReport(report);
        const textPath = `${outputPrefix}.txt`;
        const jsonPath = `${outputPrefix}.json`;
        fs.writeFileSync(textPath, renderedReport, "utf8");
        fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(colorizeAssetOpportunityHoldoutReport(renderedReport));
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
