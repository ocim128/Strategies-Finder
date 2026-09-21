import type { BacktestResult } from "../types/strategies";
import type { FinderMetric, FinderResult } from "../types/finder";

function isAscendingMetric(metric: FinderMetric): boolean {
    return metric === "maxDrawdownPercent";
}

export function getFinderSelectionResult(item: FinderResult): BacktestResult {
    return item.selectionResult;
}

export function getFinderMetricValue(
    item: FinderResult,
    metric: FinderMetric,
    options?: { useOosValues?: boolean },
): number {
    if (metric === "exitAlpha") {
        const value = options?.useOosValues === true ? item.oosExitAlpha : item.exitAlpha;
        return Number.isFinite(value) ? value! : Number.NEGATIVE_INFINITY;
    }
    const result = getFinderSelectionResult(item);
    switch (metric) {
        case "netProfit":
            return result.netProfit;
        case "netProfitPercent":
            return result.netProfitPercent;
        case "profitFactor":
            return result.profitFactor === Infinity ? Number.MAX_SAFE_INTEGER : result.profitFactor;
        case "sharpeRatio":
            return result.sharpeRatio;
        case "winRate":
            return result.winRate;
        case "maxDrawdownPercent":
            return result.maxDrawdownPercent;
        case "expectancy":
            return result.expectancy;
        case "compositeEdgeRatio":
            return item.compositeEdgeRatio
                ?? item.result.edgeStatistics?.compositeEdgeRatio
                ?? result.edgeStatistics?.compositeEdgeRatio
                ?? 0;
        case "entryScore":
            return result.tradeTimingQuality?.entryScore ?? 0;
        case "exitScore":
            return result.tradeTimingQuality?.exitScore ?? 0;
        case "averageGain":
            return result.avgWin;
        case "totalTrades":
            return result.totalTrades;
        default:
            return 0;
    }
}

export function compareFinderResults(
    a: FinderResult,
    b: FinderResult,
    sortPriority: FinderMetric[],
    options?: { useOosValues?: boolean },
): number {
    for (const metric of sortPriority) {
        const valA = getFinderMetricValue(a, metric, options);
        const valB = getFinderMetricValue(b, metric, options);
        if (Math.abs(valA - valB) > 0.0001) {
            return isAscendingMetric(metric) ? valA - valB : valB - valA;
        }
    }
    return 0;
}

export function sortFinderResults(
    results: readonly FinderResult[],
    sortPriority: FinderMetric[],
    options?: { useOosValues?: boolean },
): FinderResult[] {
    return [...results].sort((a, b) => compareFinderResults(a, b, sortPriority, options));
}
