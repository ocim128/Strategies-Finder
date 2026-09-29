import type { ReplayComparison } from "../batch-backtest/batch-open-score-usd-replay-engine";

/** The fixed set of OPEN_SCORE USD arms exposed by Finder Arm Performance. */
export const FINDER_ARM_PERFORMANCE_REPLAY_FIELDS = {
    TOP_RAW_PROFIT_NOW: "topRawProfitNow",
    TOP_MEAN_PROFIT_NOW: "topMeanProfitNow",
    TOP_RAW_PROFIT_NOW_CONF: "topRawProfitNowConf",
    TOP_Z: "topZ",
    TOP_RAW: "topRaw",
    TOP_MEAN: "topMean",
    TOP_MEAN_RAW_UNIQUE: "topMeanRawUnique",
    TOP_RAW_PROFIT: "topRawProfit",
    TOP_MEAN_PROFIT: "topMeanProfit",
    BOT_RAW_PROFIT_NOW: "botRawProfitNow",
    BOT_MEAN_PROFIT_NOW: "botMeanProfitNow",
    BOT_Z: "botZ",
    BOT_RAW: "botRaw",
    BOT_MEAN: "botMean",
    BOT_MEAN_RAW_UNIQUE: "botMeanRawUnique",
} as const satisfies Record<string, string>;

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
): number | null {
    const metric = metrics[arm];
    if (!metric || metric.events <= 0 || !Number.isFinite(metric.topMean)) return null;
    return metric.topMean;
}

export function getFinderArmPerformanceMetric<Row extends {
    metrics: FinderArmPerformanceMetrics;
    metricsExTopContributor?: FinderArmPerformanceMetrics;
}>(row: Row, arm: FinderArmPerformanceArm, basis: FinderArmPerformanceScoringBasis = "raw") {
    return basis === "exclude_top_contributor"
        ? row.metricsExTopContributor?.[arm]
        : row.metrics[arm];
}

/** Sort a copy of the complete inventory by topMean, preserving ordinal ties. */
export function sortFinderArmPerformanceResults<Row extends {
    candidateOrdinal: number;
    metrics: FinderArmPerformanceMetrics;
    metricsExTopContributor?: FinderArmPerformanceMetrics;
}>(rows: readonly Row[], arm: FinderArmPerformanceArm, filter: FinderArmPerformanceDisplayFilter = {}): Row[] {
    const basis = filter.basis ?? "raw";
    const filteredRows = filter.eventFilterEnabled
        ? rows.filter((row) => {
            const events = getFinderArmPerformanceMetric(row, arm, basis)?.events ?? 0;
            return events >= (filter.minEvents ?? 1)
                && (filter.maxEvents == null || events <= filter.maxEvents);
        })
        : rows;
    return [...filteredRows].sort((left, right) => {
        const leftValue = basis === "raw"
            ? getFinderArmPerformanceRankValue(left.metrics, arm)
            : getFinderArmPerformanceRankValue(left.metricsExTopContributor ?? {}, arm);
        const rightValue = basis === "raw"
            ? getFinderArmPerformanceRankValue(right.metrics, arm)
            : getFinderArmPerformanceRankValue(right.metricsExTopContributor ?? {}, arm);
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
