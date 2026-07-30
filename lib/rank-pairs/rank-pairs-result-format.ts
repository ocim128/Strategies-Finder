import {
    comparePairRegimeResults,
    formatAsOf,
    formatFixed,
    formatPercent,
    type PairDirection,
    type PairStructure,
} from "./pair-regime-classifier";
import {
    compareRecentPairResults,
    type RecentPairType,
} from "./recent-pair-classifier";
import type {
    RankPairsMode,
    RankResult,
    RecentRankResult,
} from "./rank-pairs-service";

export type AnyRankResult = RankResult | RecentRankResult;

const DIRECTION_ORDER: PairDirection[] = ["BASE", "NEUTRAL", "QUOTE", "THIN"];
const RECENT_TYPE_ORDER: RecentPairType[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

export function isRecentRankResult(result: AnyRankResult): result is RecentRankResult {
    return "recent" in result;
}

export function formatOverallSummary(results: RankResult[]): string {
    const ok = results.filter((result) => result.status === "ok");
    const dirCounts: Record<PairDirection, number> = { BASE: 0, NEUTRAL: 0, QUOTE: 0, THIN: 0 };
    const structCounts: Record<PairStructure, number> = {
        TREND: 0,
        OSCILLATING: 0,
        TRANSITION: 0,
        REVERSAL: 0,
        MIXED: 0,
        THIN: 0,
    };
    for (const result of ok) {
        dirCounts[result.regime.direction] += 1;
        structCounts[result.regime.structure] += 1;
    }
    const noData = results.filter((result) => result.status === "no_data").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const parts = [`Pairs ${results.length}`];
    for (const direction of DIRECTION_ORDER) {
        parts.push(`${direction} ${dirCounts[direction]}`);
    }
    parts.push(
        `TREND ${structCounts.TREND}`,
        `OSC ${structCounts.OSCILLATING}`,
        `TRANS ${structCounts.TRANSITION}`,
        `REV ${structCounts.REVERSAL}`,
        `MIXED ${structCounts.MIXED}`,
        `NODATA ${noData}`,
        `FAILED ${failed}`,
    );
    return parts.join(" | ");
}

export const COPY_HEADER = "RANK_PAIRS_V2";
export const COPY_COLUMNS = [
    "PAIR",
    "STATUS",
    "DIRECTION",
    "STRUCTURE",
    "LABEL",
    "REASON",
    "ERROR",
    "RATIO_RET",
    "LOG_RET",
    "ANN_SLOPE",
    "ANN_VOL",
    "NORM_DRIFT",
    "PATH_EFF",
    "REVERSAL_RATE",
    "HAS_RECENT",
    "RECENT_DRIFT",
    "RECENT_EFF",
    "ENDPOINT_RATIO",
    "IN_BAND",
    "ANCHORS",
    "BARS",
    "ELAPSED_DAYS",
    "AS_OF",
];

export function serializeRankResultCopyRow(result: RankResult): string {
    const metrics = result.regime.metrics;
    return [
        result.symbol,
        result.status,
        result.regime.direction,
        result.regime.structure,
        result.regime.label,
        result.regime.reason,
        result.error ?? "",
        formatPercent(metrics.ratioReturn),
        formatFixed(metrics.logReturn, 4),
        formatPercent(metrics.annualizedSlope),
        formatPercent(metrics.annualizedVolatility),
        formatFixed(metrics.normalizedDrift, 3),
        formatFixed(metrics.pathEfficiency, 3),
        formatFixed(metrics.reversalRate, 3),
        metrics.hasRecentWindow ? "yes" : "no",
        formatFixed(metrics.recentNormalizedDrift, 3),
        formatFixed(metrics.recentPathEfficiency, 3),
        formatFixed(metrics.endpointRatio, 4),
        metrics.endpointInsideBand === null ? "n/a" : metrics.endpointInsideBand ? "yes" : "no",
        String(metrics.anchorCount),
        String(metrics.barCount),
        formatFixed(metrics.elapsedDays, 0),
        formatAsOf(metrics.asOf),
    ].join(" | ");
}

export function formatCopyText(results: RankResult[]): string {
    const ranked = results
        .map((result, index) => ({ result, index }))
        .sort((a, b) => {
            const comparison = comparePairRegimeResults(a.result.regime, b.result.regime);
            return comparison !== 0 ? comparison : a.index - b.index;
        });
    return [
        COPY_HEADER,
        COPY_COLUMNS.join(" | "),
        ...ranked.map(({ result }) => serializeRankResultCopyRow(result)),
    ].join("\n");
}

export const RECENT_COPY_HEADER = "RANK_PAIRS_RECENT_200_V1";
export const RECENT_COPY_COLUMNS = [
    "PAIR",
    "STATUS",
    "TYPE",
    "DIRECTION",
    "LABEL",
    "REASON",
    "ERROR",
    "RATIO_RET",
    "LOG_RET",
    "PATH_EFF",
    "REVERSAL_RATE",
    "VOL_RATIO",
    "BASELINE_TREND",
    "RECENT_TREND",
    "LEVEL_SHIFT_SIGMA",
    "BARS",
    "AS_OF",
];

export function formatRecentOverallSummary(results: RecentRankResult[]): string {
    const counts = Object.fromEntries(
        RECENT_TYPE_ORDER.map((type) => [type, 0]),
    ) as Record<RecentPairType, number>;
    let failed = 0;
    for (const result of results) {
        if (result.status === "failed") failed += 1;
        else counts[result.recent.type] += 1;
    }
    const parts = [`Pairs ${results.length}`];
    for (const type of RECENT_TYPE_ORDER) parts.push(`TYPE ${type} ${counts[type]}`);
    parts.push(`FAILED ${failed}`);
    return parts.join(" | ");
}

export function serializeRecentRankResultCopyRow(result: RecentRankResult): string {
    const metrics = result.recent.metrics;
    return [
        result.symbol,
        result.status,
        result.recent.type,
        result.recent.direction,
        result.recent.label,
        result.recent.reason,
        result.error ?? "",
        formatPercent(metrics.ratioReturn),
        formatFixed(metrics.logReturn, 4),
        formatFixed(metrics.pathEfficiency, 3),
        formatFixed(metrics.reversalRate, 3),
        formatFixed(metrics.volatilityRatio, 3),
        formatFixed(metrics.baselineTrendStrength, 3),
        formatFixed(metrics.recentTrendStrength, 3),
        formatFixed(metrics.levelShiftSigma, 3),
        String(metrics.barCount),
        formatAsOf(metrics.asOf),
    ].join(" | ");
}

export function formatRecentCopyText(results: RecentRankResult[]): string {
    const ranked = results
        .map((result, index) => ({ result, index }))
        .sort((a, b) => {
            const comparison = compareRecentPairResults(a.result.recent, b.result.recent);
            return comparison !== 0 ? comparison : a.index - b.index;
        });
    return [
        RECENT_COPY_HEADER,
        RECENT_COPY_COLUMNS.join(" | "),
        ...ranked.map(({ result }) => serializeRecentRankResultCopyRow(result)),
    ].join("\n");
}

export function sortRankPairResults(
    results: readonly AnyRankResult[],
    mode: RankPairsMode,
): AnyRankResult[] {
    return results
        .map((result, index) => ({ result, index }))
        .sort((a, b) => {
            if (mode === "recent200" && isRecentRankResult(a.result) && isRecentRankResult(b.result)) {
                const comparison = compareRecentPairResults(a.result.recent, b.result.recent);
                return comparison !== 0 ? comparison : a.index - b.index;
            }
            if (!isRecentRankResult(a.result) && !isRecentRankResult(b.result)) {
                const comparison = comparePairRegimeResults(a.result.regime, b.result.regime);
                return comparison !== 0 ? comparison : a.index - b.index;
            }
            return a.index - b.index;
        })
        .map(({ result }) => result);
}

export function buildRankPairsSummary(results: readonly AnyRankResult[], mode: RankPairsMode): string {
    return mode === "recent200"
        ? formatRecentOverallSummary(results.filter(isRecentRankResult))
        : formatOverallSummary(results.filter(
            (result): result is RankResult => !isRecentRankResult(result),
        ));
}

export function copyPreambleForMode(mode: RankPairsMode): string[] {
    return mode === "recent200"
        ? [RECENT_COPY_HEADER, RECENT_COPY_COLUMNS.join(" | ")]
        : [COPY_HEADER, COPY_COLUMNS.join(" | ")];
}

export function serializeCopyRowForMode(result: AnyRankResult, mode: RankPairsMode): string {
    if (mode === "recent200" && isRecentRankResult(result)) {
        return serializeRecentRankResultCopyRow(result);
    }
    if (mode === "history" && !isRecentRankResult(result)) {
        return serializeRankResultCopyRow(result);
    }
    throw new Error("Rank Pairs result mode mismatch");
}
