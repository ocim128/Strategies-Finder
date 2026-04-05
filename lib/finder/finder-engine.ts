import type { BacktestResult } from "../types/strategies";
import type { FinderMetric, FinderResult } from "../types/finder";

function isAscendingMetric(metric: FinderMetric): boolean {
    return metric === "maxDrawdownPercent";
}

export function getFinderSelectionResult(item: FinderResult): BacktestResult {
    return item.selectionResult;
}

function computeWilsonLowerBound(successes: number, trials: number, z = 1.96): number {
    if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) {
        return 0;
    }

    const n = Math.max(0, trials);
    const p = Math.min(1, Math.max(0, successes / n));
    const z2 = z * z;
    const denominator = 1 + z2 / n;
    const center = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (center - margin) / denominator);
}

function computePolymarketExpectancyBalance(expectancy: number, totalTrades: number): number {
    if (!Number.isFinite(expectancy)) {
        return 0;
    }

    const normalizedTrades = Math.max(0, totalTrades);
    if (normalizedTrades === 0 || expectancy === 0) {
        return 0;
    }

    // Treat this as aggregate expected edge so both expectancy and trade count must be meaningful.
    return expectancy * normalizedTrades;
}

export function getFinderMetricValue(item: FinderResult, metric: FinderMetric): number {
    // Polymarket metrics take priority when available
    if (item.polymarketEval) {
        switch (metric) {
            case "polyScore":
                return computeWilsonLowerBound(item.polymarketEval.wins, item.polymarketEval.scoredPredictions);
            case "polyWins":
                return item.polymarketEval.wins;
            case "polyWinRate":
                return item.polymarketEval.winRate;
            case "polyCoverage":
                return item.polymarketEval.coverage;
            case "polyPredictions":
                return item.polymarketEval.scoredPredictions;
            case "polyExpectancy":
                return item.polymarketEval.expectancy ?? 0;
            case "polyExpectancyBalance":
                return computePolymarketExpectancyBalance(
                    item.polymarketEval.expectancy ?? 0,
                    item.selectionResult.totalTrades
                );
        }
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
        case "averageGain":
            return result.avgWin;
        case "totalTrades":
            return result.totalTrades;
        case "polyScore":
        case "polyWins":
        case "polyWinRate":
        case "polyCoverage":
        case "polyPredictions":
        case "polyExpectancy":
        case "polyExpectancyBalance":
            return 0; // No polymarketEval present
        default:
            return 0;
    }
}

export function compareFinderResults(a: FinderResult, b: FinderResult, sortPriority: FinderMetric[]): number {
    for (const metric of sortPriority) {
        const valA = getFinderMetricValue(a, metric);
        const valB = getFinderMetricValue(b, metric);
        if (Math.abs(valA - valB) > 0.0001) {
            return isAscendingMetric(metric) ? valA - valB : valB - valA;
        }
    }
    return 0;
}

export function sortFinderResults(results: readonly FinderResult[], sortPriority: FinderMetric[]): FinderResult[] {
    return [...results].sort((a, b) => compareFinderResults(a, b, sortPriority));
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateFinderBacktestResults(results: BacktestResult[], initialCapital: number): BacktestResult {
    if (results.length === 0) {
        return {
            trades: [],
            netProfit: 0,
            netProfitPercent: 0,
            winRate: 0,
            expectancy: 0,
            avgTrade: 0,
            profitFactor: 0,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            avgWin: 0,
            avgLoss: 0,
            sharpeRatio: 0,
            equityCurve: [],
        };
    }

    if (results.length === 1) {
        return results[0];
    }

    const avgNetProfit = average(results.map((result) => result.netProfit));
    const avgNetProfitPercent = initialCapital > 0
        ? (avgNetProfit / initialCapital) * 100
        : average(results.map((result) => result.netProfitPercent));
    const avgTrades = Math.max(0, Math.round(average(results.map((result) => result.totalTrades))));
    const avgWinRate = average(results.map((result) => result.winRate));
    const winningTrades = Math.max(0, Math.round((avgWinRate / 100) * avgTrades));
    const losingTrades = Math.max(0, avgTrades - winningTrades);
    const finiteProfitFactors = results.map((result) => result.profitFactor).map((value) => {
        if (Number.isFinite(value)) return Math.max(0, value);
        return 4;
    });

    return {
        trades: [],
        netProfit: avgNetProfit,
        netProfitPercent: avgNetProfitPercent,
        winRate: avgWinRate,
        expectancy: average(results.map((result) => result.expectancy)),
        avgTrade: average(results.map((result) => result.avgTrade)),
        profitFactor: average(finiteProfitFactors),
        maxDrawdown: average(results.map((result) => result.maxDrawdown)),
        maxDrawdownPercent: average(results.map((result) => result.maxDrawdownPercent)),
        totalTrades: avgTrades,
        winningTrades,
        losingTrades,
        avgWin: average(results.map((result) => result.avgWin)),
        avgLoss: average(results.map((result) => result.avgLoss)),
        sharpeRatio: average(results.map((result) => result.sharpeRatio)),
        equityCurve: [],
    };
}
