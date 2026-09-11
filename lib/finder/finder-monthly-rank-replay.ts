/**
 * Monthly Rank Replay — replay contracts and pure ranking/report math.
 *
 * A submode of Symbol Universe: at each UTC month boundary T, select rank #1
 * independently for every existing historical Universe sort using only
 * information closed by T, then measure each distinct winner over H forward
 * bars. Configuration identity is audit detail; the summary rows are per sort.
 *
 * LEAF MODULE: imported by the server plugin (`finder-vite-plugin.ts`), so it
 * must not reach browser-bound modules (`lib/finder-manager.ts`,
 * `lib/data-manager.ts`, anything importing `lightweight-charts`).
 *
 * Ranking meaning is delegated to the existing Universe metric layer:
 * `getFinderUniverseMetricValue` supplies each sort's score and
 * `isAscendingUniverseMetric` supplies its direction. This module adds only
 * the replay-specific parts: metric availability (unavailable ≠ zero), one
 * best-so-far slot per sort taken from the COMPLETE eligible pool, full
 * deterministic identity tie-breaking, and per-sort summary arithmetic.
 */

import type { FinderUniverseMetric } from "../types/finder";
import type { FinderMonthlyRankReplayOptions } from "../types/finder";
import type { StrategyParams } from "../types/strategies";
import {
    UNIVERSE_SORT_OPTIONS,
    UNIVERSE_METRIC_FULL_LABELS,
} from "./constants";
import {
    computeRobustUniverseScore,
    getFinderUniverseMetricValue,
    isAscendingUniverseMetric,
} from "./finder-universe-metrics";
import type { FinderUniverseCandidate } from "../types/finder";
import { stableStringify } from "../json-utils";
import { parseIntervalSeconds } from "../interval-utils";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** User-facing Monthly Rank Replay inputs (all three required). */
export type MonthlyRankReplayOptions = FinderMonthlyRankReplayOptions;

const MIN_REPLAY_YEAR = 1990;
const MAX_REPLAY_YEAR = 2100;

/**
 * Validate replay options. Malformed explicit options throw — the caller must
 * never fall back to ordinary Universe silently. Returns the normalized shape.
 */
export function validateMonthlyRankReplayOptions(value: unknown): MonthlyRankReplayOptions {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Monthly Rank Replay options must be an object.");
    }
    const source = value as Record<string, unknown>;
    const fromYear = source.fromYear;
    if (typeof fromYear !== "number" || !Number.isInteger(fromYear)
        || fromYear < MIN_REPLAY_YEAR || fromYear > MAX_REPLAY_YEAR) {
        throw new Error(
            `Monthly Rank Replay fromYear must be an integer between ${MIN_REPLAY_YEAR} and ${MAX_REPLAY_YEAR}.`,
        );
    }
    const evalWindowBars = source.evalWindowBars;
    if (typeof evalWindowBars !== "number" || !Number.isInteger(evalWindowBars) || evalWindowBars <= 0) {
        throw new Error("Monthly Rank Replay evalWindowBars (L) must be a positive integer.");
    }
    const forwardBars = source.forwardBars;
    if (typeof forwardBars !== "number" || !Number.isInteger(forwardBars) || forwardBars <= 0) {
        throw new Error("Monthly Rank Replay forwardBars (H) must be a positive integer.");
    }
    return { fromYear, evalWindowBars, forwardBars };
}

// ---------------------------------------------------------------------------
// Sort coverage
// ---------------------------------------------------------------------------

export type MonthlyRankReplaySortDirection = "descending" | "ascending";

export interface MonthlyRankReplaySortCoverage {
    key: FinderUniverseMetric;
    label: string;
    direction: MonthlyRankReplaySortDirection;
    /** True when lower values rank first (drawdown minima). */
    ascending: boolean;
}

export interface MonthlyRankReplayExcludedSort {
    key: FinderUniverseMetric;
    label: string;
    reason: string;
}

/**
 * OOS-dependent sorts can never select a winner for the same forward period
 * they consume. Anything added to Universe later must be classified here
 * before it can join replay coverage.
 */
export const MONTHLY_RANK_REPLAY_EXCLUDED_SORTS: readonly FinderUniverseMetric[] = [
    "windowStabilityScore",
];

const EXCLUDED_SORT_REASONS: Partial<Record<FinderUniverseMetric, string>> = {
    windowStabilityScore:
        "Window Stability Score consumes OOS outcomes from the same forward region it would rank; replay excludes OOS-dependent sorts.",
};

/**
 * Split the shared Universe sort registry into replayed sorts (with direction)
 * and excluded sorts (with reasons). Ordinary dropdown order is preserved.
 */
export function resolveMonthlyRankReplaySortCoverage(): {
    replayed: MonthlyRankReplaySortCoverage[];
    excluded: MonthlyRankReplayExcludedSort[];
} {
    const replayed: MonthlyRankReplaySortCoverage[] = [];
    const excluded: MonthlyRankReplayExcludedSort[] = [];
    for (const key of UNIVERSE_SORT_OPTIONS) {
        const label = UNIVERSE_METRIC_FULL_LABELS[key];
        if (MONTHLY_RANK_REPLAY_EXCLUDED_SORTS.includes(key)) {
            excluded.push({
                key,
                label,
                reason: EXCLUDED_SORT_REASONS[key] ?? "Sort is excluded from replay.",
            });
            continue;
        }
        const ascending = isAscendingUniverseMetric(key);
        replayed.push({
            key,
            label,
            direction: ascending ? "ascending" : "descending",
            ascending,
        });
    }
    return { replayed, excluded };
}

// ---------------------------------------------------------------------------
// Metric availability
// ---------------------------------------------------------------------------

/**
 * Metric-specific availability for one candidate. Availability mirrors the
 * observation filters inside the ordinary aggregate (`classifyCounts`): a sort
 * is available only when its formula actually observed values. Unavailable is
 * distinct from zero — a finite 0.00 median Sharpe remains available.
 */
export function isMonthlyRankReplayMetricAvailable(
    candidate: FinderUniverseCandidate,
    metric: FinderUniverseMetric,
): boolean {
    if (MONTHLY_RANK_REPLAY_EXCLUDED_SORTS.includes(metric)) {
        return false;
    }
    switch (metric) {
        case "robustUniverseScore":
        case "activeSymbols":
        case "totalTrades":
            return true;
        case "profitableActiveRatio":
        case "medianExpectancy":
        case "medianExpectancyWeightedTrades":
        case "worstNetProfit":
            // These aggregate over active symbols only; with zero active
            // symbols the ordinary aggregate reports a placeholder 0.
            return candidate.activeSymbols > 0;
        case "medianSharpe":
            return candidate.medianSharpeAvailable === true
                && Number.isFinite(candidate.medianSharpe);
        case "medianProfitFactor":
            return candidate.activeSymbols > 0
                && (Number.isFinite(candidate.medianProfitFactor)
                    || candidate.medianProfitFactor === Number.POSITIVE_INFINITY);
        case "medianProfitFactorWeightedTrades": {
            if (!isMonthlyRankReplayMetricAvailable(candidate, "medianProfitFactor")) return false;
            const value = candidate.medianProfitFactor * candidate.totalTrades;
            return Number.isFinite(value) || value === Number.POSITIVE_INFINITY;
        }
        case "medianCompositeEdgeRatio":
        case "medianExitAlpha":
            // Ordinary aggregates substitute 0 / drop the field when no
            // observation exists; replay counts the observations directly.
            return countFiniteSymbolObservations(candidate, metric) > 0;
        case "worstMaxDrawdownPercent":
        case "medianMaxDrawdownPercent":
        case "medianReturnDrawdownRatio":
            return countFiniteSymbolObservations(candidate, metric) > 0;
        default:
            return false;
    }
}

/**
 * Count per-symbol observations the ordinary aggregate would admit for one
 * metric family. Mirrors the exact filters in `classifyCounts` (active
 * symbols with trades; finite composite-edge/exit-alpha values; symbols with
 * `drawdownAvailable === true`).
 */
function countFiniteSymbolObservations(
    candidate: FinderUniverseCandidate,
    metric: FinderUniverseMetric,
): number {
    let count = 0;
    for (const symbol of candidate.symbols) {
        const result = symbol.result;
        if (!result || result.totalTrades <= 0) continue;
        if (metric === "medianCompositeEdgeRatio") {
            if (typeof result.compositeEdgeRatio === "number" && Number.isFinite(result.compositeEdgeRatio)) count += 1;
        } else if (metric === "medianExitAlpha") {
            if (typeof result.exitAlpha === "number" && Number.isFinite(result.exitAlpha)) count += 1;
        } else {
            if (result.drawdownAvailable === true && Number.isFinite(result.maxDrawdownPercent)) count += 1;
        }
    }
    return count;
}

// ---------------------------------------------------------------------------
// Robust Universe Score single-sort dependency
// ---------------------------------------------------------------------------

/**
 * Robust Universe Score as the ORDINARY single sort computes it. The ordinary
 * robust sort never requests Composite Edge Ratio, so its candidates carry
 * `medianCompositeEdgeRatio === 0` and the score always takes the profit-
 * factor fallback (`computeRobustUniverseScore`'s CER branch never fires).
 * Replay computes CER for the separate edge sort; feeding those observations
 * into the robust score would silently switch this row onto a different
 * composite formula. Recomputing with CER absent preserves the sort's own
 * single-sort dependency/fallback behavior (blueprint section 3).
 */
export function computeReplayRobustUniverseScore(candidate: FinderUniverseCandidate): number {
    return computeRobustUniverseScore({
        ...candidate,
        medianCompositeEdgeRatio: 0,
    });
}

// ---------------------------------------------------------------------------
// Winner accumulator
// ---------------------------------------------------------------------------

const METRIC_TIE_EPSILON = 0.0001;

export interface MonthlyRankReplayWinnerEntry {
    sortKey: FinderUniverseMetric;
    /** The sort's own score for the winner (may be +Infinity, e.g. PF). */
    score: number;
    candidate: FinderUniverseCandidate;
    /** Stable canonical identity key of the winner. */
    identityKey: string;
    /** Frozen candidate generation ordinal (stable dedup order). */
    ordinal: number;
}

/**
 * One best-so-far slot per replayed sort, fed from the complete eligible
 * candidate pool BEFORE any top-N truncation. Selection preserves each sort's
 * existing formula/direction; ties resolve by canonical full identity, then
 * by the frozen generation ordinal. Equal infinities compare as equal (they
 * are never subtracted).
 */
export class MonthlyRankReplayWinnerAccumulator {
    private readonly best = new Map<FinderUniverseMetric, MonthlyRankReplayWinnerEntry>();

    constructor(private readonly sortKeys: readonly FinderUniverseMetric[]) {}

    /**
     * Offer one COMPLETE candidate. Candidates with an unavailable metric are
     * skipped for that sort only; a systemic incomplete candidate must never
     * reach this accumulator.
     */
    offer(candidate: FinderUniverseCandidate, identityKey: string, ordinal: number): void {
        for (const sortKey of this.sortKeys) {
            if (!isMonthlyRankReplayMetricAvailable(candidate, sortKey)) continue;
            const score = getFinderUniverseMetricValue(candidate, sortKey);
            const entry: MonthlyRankReplayWinnerEntry = { sortKey, score, candidate, identityKey, ordinal };
            const current = this.best.get(sortKey);
            if (!current || this.compare(entry, current, sortKey) < 0) {
                this.best.set(sortKey, entry);
            }
        }
    }

    winners(): Map<FinderUniverseMetric, MonthlyRankReplayWinnerEntry> {
        return new Map(this.best);
    }

    /** Negative when `next` ranks better than `current` for `sortKey`. */
    private compare(next: MonthlyRankReplayWinnerEntry, current: MonthlyRankReplayWinnerEntry, sortKey: FinderUniverseMetric): number {
        const ascending = isAscendingUniverseMetric(sortKey);
        const delta = compareMetricScores(next.score, current.score, ascending);
        if (delta !== 0) return delta;
        if (next.identityKey !== current.identityKey) {
            return next.identityKey < current.identityKey ? -1 : 1;
        }
        return next.ordinal - current.ordinal;
    }
}

/**
 * Direction-correct score comparison mirroring the ordinary comparator:
 * epsilon tie, ascending sorts prefer the smaller value, and the ordinary
 * `-Infinity` sentinel (missing Exit Alpha) always ranks worse.
 */
export function compareMetricScores(
    left: number,
    right: number,
    ascending: boolean,
): number {
    if (left === Number.NEGATIVE_INFINITY || right === Number.NEGATIVE_INFINITY) {
        if (left === right) return 0;
        return left === Number.NEGATIVE_INFINITY ? 1 : -1;
    }
    if (Math.abs(left - right) <= METRIC_TIE_EPSILON) return 0;
    const betterIsSmaller = ascending;
    if (left === right) return 0;
    return betterIsSmaller
        ? (left < right ? -1 : 1)
        : (left > right ? -1 : 1);
}

// ---------------------------------------------------------------------------
// Canonical identity
// ---------------------------------------------------------------------------

export interface MonthlyRankReplayIdentityInput {
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyParams?: StrategyParams;
    /** Resolved backtest settings affecting execution for this candidate. */
    effectiveSettings?: unknown;
}

/**
 * Stable full-configuration identity: entry strategy + normalized params +
 * exit identity + effective execution settings, serialized in stable key
 * order. Two candidates with the same identity share forward evaluations.
 */
export function buildMonthlyRankReplayIdentityKey(identity: MonthlyRankReplayIdentityInput): string {
    return stableStringify({
        strategyKey: identity.strategyKey,
        params: identity.params ?? {},
        ...(identity.exitStrategyKey ? { exitStrategyKey: identity.exitStrategyKey } : {}),
        ...(identity.exitStrategyKey ? { exitStrategyParams: identity.exitStrategyParams ?? {} } : {}),
        ...(identity.effectiveSettings !== undefined
            ? { effectiveSettings: identity.effectiveSettings }
            : {}),
    });
}

// ---------------------------------------------------------------------------
// Checkpoint schedule
// ---------------------------------------------------------------------------

export interface MonthlyRankReplayCheckpoint {
    /** UTC month boundary (unix seconds). Bars close exactly at or before it. */
    timeSec: number;
    /** 1-based ordinal within the schedule. */
    index: number;
    /** ISO label for display. */
    label: string;
}

/**
 * Enumerate UTC month-start boundaries starting at January of `fromYear`
 * through the last boundary at or before `lastClosedTimeSec`. `fromYear` is
 * never silently advanced: boundaries the data cannot support are kept and
 * reported unavailable by the runner.
 */
export function buildMonthlyCheckpointSchedule(fromYear: number, lastClosedTimeSec: number): MonthlyRankReplayCheckpoint[] {
    const checkpoints: MonthlyRankReplayCheckpoint[] = [];
    const start = Date.UTC(fromYear, 0, 1) / 1000;
    let year = fromYear;
    let month = 0;
    let index = 1;
    while (true) {
        const timeSec = Date.UTC(year, month, 1) / 1000;
        if (timeSec > lastClosedTimeSec) break;
        checkpoints.push({
            timeSec,
            index,
            label: new Date(timeSec * 1000).toISOString().slice(0, 7),
        });
        index += 1;
        month += 1;
        if (month > 11) {
            month = 0;
            year += 1;
        }
        if (checkpoints.length > 12 * 200) break; // defensive bound
    }
    if (start > lastClosedTimeSec) return [];
    return checkpoints;
}

/** Close boundary of a bar: open time plus the interval duration. */
export function resolveBarCloseTimeSec(barOpenTimeSec: number, interval: string): number | null {
    const intervalSec = parseIntervalSeconds(interval);
    if (intervalSec === null || intervalSec <= 0) return null;
    return barOpenTimeSec + intervalSec;
}

// ---------------------------------------------------------------------------
// Report contracts
// ---------------------------------------------------------------------------

/** Status of one sort's selection at one checkpoint. */
export type MonthlyRankReplaySelectionStatus =
    | "measured"
    | "no_selection"
    | "incomplete_horizon"
    | "forward_failed"
    | "forward_invalid"
    | "cancelled";

/** Per-symbol scalar outcome inside one forward evaluation. */
export interface MonthlyRankReplaySymbolOutcome {
    symbol: string;
    /** Equal-weight basis tag: ordinary cash or pair-neutral synthetic. */
    measurementBasis: "cash" | "pair_neutral_log" | "no_trades";
    /** Symbol return percent over the scored forward window (0 for valid no-trade). */
    returnPercent: number;
    totalTrades: number;
    scoredStartLabel?: string;
    scoredEndLabel?: string;
    warmupBars: number;
    /** Set when this symbol's evaluation failed (invalidates the window). */
    error?: string;
}

/** One deduplicated forward evaluation: (checkpoint, distinct winner identity). */
export interface MonthlyRankReplayForwardOutcome {
    /** Index into report.checkpoints. */
    checkpointIndex: number;
    checkpointLabel: string;
    identityKey: string;
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyName?: string;
    exitStrategyParams?: StrategyParams;
    status: "measured" | "incomplete_horizon" | "failed";
    reason?: string;
    /** Equal-weight mean of symbol returns across the fixed symbol set. */
    windowReturnPercent: number | null;
    totalTrades: number;
    /** Actual scored forward window bounds (unix seconds). */
    forwardStartSec: number | null;
    forwardEndSec: number | null;
    symbols: MonthlyRankReplaySymbolOutcome[];
}

/**
 * Exact random-choice baseline for one sort at one checkpoint: the eligible
 * pool (historical completeness + filters + metric availability, checkpoint
 * information only) is measured forward and averaged with equal weight per
 * unique configuration, winner included. Excess = top-1 − random mean.
 */
export type MonthlyRankReplayComparisonStatus = "measured" | "uninformative" | "unavailable";

export interface MonthlyRankReplayComparison {
    status: MonthlyRankReplayComparisonStatus;
    /** Why the comparison is uninformative/unavailable (status != measured). */
    reason?: string;
    /** Eligible pool size for THIS sort (sorts may have different pools). */
    eligibleConfigurations: number;
    randomExpectedReturnPercent?: number | null;
    excessReturnPercent?: number | null;
}

/** One sort's selection record at one checkpoint. */
export interface MonthlyRankReplaySelection {
    checkpointIndex: number;
    checkpointLabel: string;
    sortKey: FinderUniverseMetric;
    sortLabel: string;
    direction: MonthlyRankReplaySortDirection;
    /** The sort's historical score for the winner (may be +Infinity). */
    score: number | null;
    /** Historical aggregation label + contributing-symbol counts. */
    aggregationLabel: string;
    historicalActiveSymbols: number;
    historicalSharpeContributors: number;
    status: MonthlyRankReplaySelectionStatus;
    reason?: string;
    identityKey?: string;
    strategyKey?: string;
    strategyName?: string;
    params?: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyParams?: StrategyParams;
    /** Index into report.forwardOutcomes when a forward evaluation exists. */
    forwardOutcomeIndex?: number;
    forwardReturnPercent?: number | null;
    /** Exact random-choice baseline comparison for this sort/checkpoint. */
    comparison?: MonthlyRankReplayComparison;
}

export interface MonthlyRankReplaySortSummary {
    sortKey: FinderUniverseMetric;
    sortLabel: string;
    direction: MonthlyRankReplaySortDirection;
    scheduledCheckpoints: number;
    validCheckpoints: number;
    /** Mean forward H-bar return % over this sort's valid checkpoints. */
    meanForwardReturnPercent: number | null;
    medianForwardReturnPercent: number | null;
    /** Strictly positive (unrounded) valid windows. */
    positiveWindows: number;
    negativeWindows: number;
    /** Valid windows whose winner traded nowhere in the scored window. */
    zeroTradeWindows: number;
    worstWindowReturnPercent: number | null;
    bestWindowReturnPercent: number | null;
    /** Valid-checkpoint / scheduled denominator shown with the row. */
    coverage: string;
    excludedCounts: Array<{ reason: string; count: number }>;
    /** Checkpoints with a valid (measured) random comparison. */
    comparisonCheckpoints: number;
    comparisonCoverage: string;
    /** Mean of the random-pool expected returns over comparison checkpoints. */
    randomMeanForwardReturnPercent: number | null;
    /** Mean of (top-1 − random mean) over comparison checkpoints, in pp. */
    meanExcessReturnPercent: number | null;
    /** Comparison checkpoints whose top-1 exceeded the random mean. */
    positiveExcessWindows: number;
    /**
     * Top-1 mean over the COMPARISON checkpoints. Surfaced when comparison
     * coverage differs from the Top 1 coverage so the displayed averages
     * cannot suggest a comparison across different months.
     */
    pairedTop1MeanForwardReturnPercent: number | null;
}

export interface MonthlyRankReplayCheckpointRecord {
    index: number;
    label: string;
    timeSec: number;
    /** Whether any sort could select + measure at this checkpoint. */
    status: "measured" | "unavailable" | "skipped";
    reason?: string;
    /** Distinct winners forwarded at this checkpoint. */
    distinctWinners: number;
    /**
     * Point-in-time membership: symbols evaluated at this checkpoint. Symbols
     * with insufficient scored history, an incomplete forward horizon, or a
     * failed load are excluded from the checkpoint and named on
     * {@link excludedSymbols}; window means use the retained set.
     */
    retainedSymbols?: number;
    excludedSymbols?: Array<{ symbol: string; reason: string }>;
}

export interface MonthlyRankReplaySymbolCoverage {
    symbol: string;
    bars: number;
    firstOpenLabel?: string;
    lastCloseLabel?: string;
    /** Last bar whose close is at or before the first scheduled checkpoint. */
    warmupBarsAtFirstCheckpoint: number;
    synthetic: boolean;
    error?: string;
}

export interface MonthlyRankReplayExperiment {
    fromYear: number;
    evalWindowBars: number;
    forwardBars: number;
    interval: string;
    symbols: string[];
    strategyKeys: string[];
    replayedSorts: Array<{ key: string; label: string; direction: MonthlyRankReplaySortDirection }>;
    excludedSorts: MonthlyRankReplayExcludedSort[];
    engine: "typescript";
    sizingMode: "fixed";
    capitalSettings: Record<string, unknown>;
    candidatePool: {
        requestedRunsPerStrategy: number;
        actualCandidates: number;
        seed: number | null;
    };
    conventions: {
        checkpoint: string;
        historicalWindow: string;
        forwardWindow: string;
        signalPolicy: string;
        accounting: string;
        baseline: string;
    };
}

export interface MonthlyRankReplayReport {
    kind: "monthly_rank_replay";
    runId: string;
    experiment: MonthlyRankReplayExperiment;
    checkpoints: MonthlyRankReplayCheckpointRecord[];
    symbolCoverage: MonthlyRankReplaySymbolCoverage[];
    forwardOutcomes: MonthlyRankReplayForwardOutcome[];
    selections: MonthlyRankReplaySelection[];
    sortSummaries: MonthlyRankReplaySortSummary[];
    /** Present when the run ended early (cancel/stop) with partial results. */
    stoppedEarly?: { reason: string; completedCheckpoints: number };
    fatal?: string;
    /**
     * True when per-checkpoint detail (selections + forwardOutcomes) was
     * dropped by snapshot compaction or reload recovery; only the summary
     * rows and experiment metadata remain. Copy then describes the summary
     * and labels detail unavailable instead of implying the full report.
     */
    detailUnavailable?: boolean;
}

// ---------------------------------------------------------------------------
// Summary arithmetic
// ---------------------------------------------------------------------------

/** One valid paired comparison observation for a sort. */
export interface MonthlyRankReplayComparisonObservation {
    top1Return: number;
    randomExpected: number;
    excess: number;
}

export interface MonthlyRankReplaySummaryInput {
    coverage: MonthlyRankReplaySortCoverage;
    scheduledCheckpoints: number;
    /** Valid forward window returns (percent) for this sort. */
    validReturns: number[];
    zeroTradeValid: number;
    excludedReasons: string[];
    /** Valid paired comparisons (top-1 vs random pool mean) for this sort. */
    comparisons: MonthlyRankReplayComparisonObservation[];
}

/**
 * Per-sort summary arithmetic. Each sort summarizes ONLY its own valid
 * checkpoints — no all-sort common-month intersection. Zero-return windows
 * stay in the denominator; empty summaries report unavailable values rather
 * than misleading zeroes.
 */
export function summarizeMonthlyRankReplaySort(input: MonthlyRankReplaySummaryInput): MonthlyRankReplaySortSummary {
    const returns = input.validReturns;
    const valid = returns.length;
    const mean = valid > 0 ? returns.reduce((sum, value) => sum + value, 0) / valid : null;
    const median = valid > 0 ? medianOf(returns) : null;
    const positive = returns.filter((value) => value > 0).length;
    const negative = returns.filter((value) => value < 0).length;
    const excludedCounts = new Map<string, number>();
    for (const reason of input.excludedReasons) {
        excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);
    }
    const comparisons = input.comparisons;
    const comparisonCheckpoints = comparisons.length;
    const randomMean = comparisonCheckpoints > 0
        ? comparisons.reduce((sum, entry) => sum + entry.randomExpected, 0) / comparisonCheckpoints
        : null;
    const meanExcess = comparisonCheckpoints > 0
        ? comparisons.reduce((sum, entry) => sum + entry.excess, 0) / comparisonCheckpoints
        : null;
    const positiveExcess = comparisons.filter((entry) => entry.excess > 0).length;
    const pairedTop1 = comparisonCheckpoints > 0
        ? comparisons.reduce((sum, entry) => sum + entry.top1Return, 0) / comparisonCheckpoints
        : null;
    return {
        comparisonCheckpoints,
        comparisonCoverage: `${comparisonCheckpoints}/${input.scheduledCheckpoints}`,
        randomMeanForwardReturnPercent: randomMean,
        meanExcessReturnPercent: meanExcess,
        positiveExcessWindows: positiveExcess,
        pairedTop1MeanForwardReturnPercent: pairedTop1,
        sortKey: input.coverage.key,
        sortLabel: input.coverage.label,
        direction: input.coverage.direction,
        scheduledCheckpoints: input.scheduledCheckpoints,
        validCheckpoints: valid,
        meanForwardReturnPercent: mean,
        medianForwardReturnPercent: median,
        positiveWindows: positive,
        negativeWindows: negative,
        zeroTradeWindows: input.zeroTradeValid,
        worstWindowReturnPercent: valid > 0 ? Math.min(...returns) : null,
        bestWindowReturnPercent: valid > 0 ? Math.max(...returns) : null,
        coverage: `${valid}/${input.scheduledCheckpoints}`,
        excludedCounts: [...excludedCounts.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
}

function medianOf(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Build one sort's random-choice comparison at one checkpoint.
 *
 * Pool = every historically eligible configuration for the sort (equal
 * probability per unique configuration, winner included). A comparison is
 * valid only when EVERY pool member's forward evaluation succeeded — a
 * missing/failed outcome marks the comparison unavailable without shrinking
 * the pool. Fewer than two eligible configurations is uninformative: the
 * random mean collapses to the selected configuration itself.
 */
export function buildRandomComparison(args: {
    eligibleIdentityKeys: readonly string[];
    forwardResults: ReadonlyMap<string, { measured: boolean; value: number | null }>;
    selectedIdentityKey: string;
}): MonthlyRankReplayComparison {
    const poolSize = args.eligibleIdentityKeys.length;
    if (poolSize < 2) {
        return {
            status: "uninformative",
            reason: "fewer than two eligible configurations",
            eligibleConfigurations: poolSize,
        };
    }
    const values: number[] = [];
    let missing = 0;
    for (const identityKey of args.eligibleIdentityKeys) {
        const result = args.forwardResults.get(identityKey);
        if (!result || !result.measured || result.value === null || !Number.isFinite(result.value)) {
            missing += 1;
            continue;
        }
        values.push(result.value);
    }
    if (missing > 0) {
        return {
            status: "unavailable",
            reason: `forward evaluation unavailable for ${missing} of ${poolSize} pool configurations`,
            eligibleConfigurations: poolSize,
        };
    }
    const selected = args.forwardResults.get(args.selectedIdentityKey);
    const selectedValue = selected && selected.measured && selected.value !== null ? selected.value : Number.NaN;
    if (!Number.isFinite(selectedValue)) {
        return {
            status: "unavailable",
            reason: "selected configuration's forward evaluation is unavailable",
            eligibleConfigurations: poolSize,
        };
    }
    const randomMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
        status: "measured",
        eligibleConfigurations: poolSize,
        randomExpectedReturnPercent: randomMean,
        excessReturnPercent: selectedValue - randomMean,
    };
}

/**
 * Aggregate per-symbol returns into the equal-weight window return. Missing /
 * failed evaluations must never be averaged as zero: callers pass only
 * successfully evaluated symbols and record failures separately.
 */
export function computeWindowReturnPercent(symbolReturns: number[]): number | null {
    if (symbolReturns.length === 0) return null;
    return symbolReturns.reduce((sum, value) => sum + value, 0) / symbolReturns.length;
}
