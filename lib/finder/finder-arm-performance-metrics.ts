import type { ReplayComparison } from "../batch-backtest/batch-open-score-usd-replay-engine";
import type { AssetSwitchArmSummary, ReplayMode } from "../batch-backtest/open-score-replay/types";
import { REPLAY_ARM_TO_FINDER_ARM } from "../batch-backtest/open-score-replay/arm-contract";
import type { FinderArmField, ReplayArmField } from "../batch-backtest/open-score-replay/arm-contract";

/** The fixed set of OPEN_SCORE USD arms exposed by Finder Arm Performance. */
export const FINDER_ARM_PERFORMANCE_REPLAY_FIELDS = Object.fromEntries(
    Object.entries(REPLAY_ARM_TO_FINDER_ARM).map(([field, arm]) => [arm, field]),
) as Readonly<Record<FinderArmField, ReplayArmField>>;

export type FinderArmPerformanceArm = keyof typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS;
export type FinderArmPerformanceReplayField =
    (typeof FINDER_ARM_PERFORMANCE_REPLAY_FIELDS)[FinderArmPerformanceArm];

/** Compact comparison values retained per candidate and arm. */
export interface FinderArmPerformanceMetric {
    events: number;
    topMean: number | null;
    randomMean: number | null;
    delta: number | null;
    topMedian: number | null;
    ciLower: number | null;
    ciUpper: number | null;
    positiveBlocks: number;
    totalBlocks: number;
}

export type FinderArmPerformanceMetrics = Partial<
    Record<FinderArmPerformanceArm, FinderArmPerformanceMetric>
>;
export type FinderArmPerformanceCompleteMetrics = Record<
    FinderArmPerformanceArm,
    FinderArmPerformanceMetric
>;

export type FinderArmPerformanceScoringBasis = "raw" | "exclude_top_contributor";
export interface FinderArmPerformanceDisplayFilter {
    basis?: FinderArmPerformanceScoringBasis;
    eventFilterEnabled?: boolean;
    minEvents?: number;
    maxEvents?: number | null;
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Copy only the supported scalar fields from a stored arm metric. */
export function compactFinderArmPerformanceMetric(
    metric: Partial<FinderArmPerformanceMetric>,
): FinderArmPerformanceMetric {
    return {
        events: nonNegativeInteger(metric.events),
        topMean: finiteOrNull(metric.topMean),
        randomMean: finiteOrNull(metric.randomMean),
        delta: finiteOrNull(metric.delta),
        topMedian: finiteOrNull(metric.topMedian),
        ciLower: finiteOrNull(metric.ciLower),
        ciUpper: finiteOrNull(metric.ciUpper),
        positiveBlocks: nonNegativeInteger(metric.positiveBlocks),
        totalBlocks: nonNegativeInteger(metric.totalBlocks),
    };
}

export function compactFinderArmComparison(comparison: ReplayComparison): FinderArmPerformanceMetric {
    return compactFinderArmPerformanceMetric(comparison);
}

/**
 * Returns the arm's ranking metric. Zero-event arms and non-finite means are
 * unavailable; zero and negative finite means remain rankable.
 */
export function getFinderArmPerformanceRankValue(
    metrics: FinderArmPerformanceMetrics,
    arm: FinderArmPerformanceArm,
    replayMode: ReplayMode = "horizon",
    switchMetric?: AssetSwitchArmSummary,
): number | null {
    if (replayMode === "asset_switch") {
        return switchMetric?.status === "complete" && Number.isFinite(switchMetric.totalNetPnl)
            ? switchMetric.totalNetPnl
            : null;
    }
    const metric = metrics[arm];
    if (!metric || metric.events <= 0 || !Number.isFinite(metric.topMean)) return null;
    return metric.topMean;
}

export function getFinderArmPerformanceMetric<Row extends {
    replayMode?: ReplayMode;
    metrics?: FinderArmPerformanceMetrics;
    metricsExTopContributor?: FinderArmPerformanceMetrics;
    assetSwitchMetrics?: Partial<Record<FinderArmPerformanceArm, AssetSwitchArmSummary>>;
}>(row: Row, arm: FinderArmPerformanceArm, basis: FinderArmPerformanceScoringBasis = "raw") {
    if (row.replayMode === "asset_switch") return row.assetSwitchMetrics?.[arm];
    return basis === "exclude_top_contributor"
        ? row.metricsExTopContributor?.[arm]
        : row.metrics?.[arm];
}

/** Sort a copy of the complete inventory by topMean, preserving ordinal ties. */
export function sortFinderArmPerformanceResults<Row extends {
    candidateOrdinal: number;
    replayMode?: ReplayMode;
    metrics?: FinderArmPerformanceMetrics;
    metricsExTopContributor?: FinderArmPerformanceMetrics;
    assetSwitchMetrics?: Partial<Record<FinderArmPerformanceArm, AssetSwitchArmSummary>>;
}>(rows: readonly Row[], arm: FinderArmPerformanceArm, filter: FinderArmPerformanceDisplayFilter = {}): Row[] {
    const basis = filter.basis ?? "raw";
    const filteredRows = filter.eventFilterEnabled
        ? rows.filter((row) => {
            const metric = getFinderArmPerformanceMetric(row, arm, basis);
            const count = row.replayMode === "asset_switch"
                ? (metric as AssetSwitchArmSummary | undefined)?.completedTrades ?? 0
                : (metric as FinderArmPerformanceMetric | undefined)?.events ?? 0;
            return count >= (filter.minEvents ?? 1)
                && (filter.maxEvents == null || count <= filter.maxEvents);
        })
        : rows;
    return [...filteredRows].sort((left, right) => {
        const leftMode = left.replayMode ?? "horizon";
        const rightMode = right.replayMode ?? "horizon";
        const leftValue = leftMode === "asset_switch"
            ? getFinderArmPerformanceRankValue({}, arm, leftMode, left.assetSwitchMetrics?.[arm])
            : getFinderArmPerformanceRankValue(
                basis === "raw" ? left.metrics ?? {} : left.metricsExTopContributor ?? {}, arm,
            );
        const rightValue = rightMode === "asset_switch"
            ? getFinderArmPerformanceRankValue({}, arm, rightMode, right.assetSwitchMetrics?.[arm])
            : getFinderArmPerformanceRankValue(
                basis === "raw" ? right.metrics ?? {} : right.metricsExTopContributor ?? {}, arm,
            );
        if (leftValue === null && rightValue !== null) return 1;
        if (leftValue !== null && rightValue === null) return -1;
        if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
            return rightValue - leftValue;
        }
        return left.candidateOrdinal - right.candidateOrdinal;
    });
}

export function buildFinderArmPerformanceMetrics(
    replayHorizon: Record<FinderArmPerformanceReplayField, ReplayComparison>,
): FinderArmPerformanceCompleteMetrics {
    const metrics = {} as FinderArmPerformanceCompleteMetrics;
    for (const [arm, field] of Object.entries(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as Array<
        [FinderArmPerformanceArm, FinderArmPerformanceReplayField]
    >) {
        metrics[arm] = compactFinderArmComparison(replayHorizon[field]);
    }
    return metrics;
}

/** Compact an already arm-keyed coordinator summary without remapping fields. */
export function buildFinderArmPerformanceMetricsFromArms(
    armComparisons: Record<FinderArmPerformanceArm, ReplayComparison>,
): FinderArmPerformanceCompleteMetrics {
    const metrics = {} as FinderArmPerformanceCompleteMetrics;
    for (const arm of Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as FinderArmPerformanceArm[]) {
        metrics[arm] = compactFinderArmComparison(armComparisons[arm]);
    }
    return metrics;
}
