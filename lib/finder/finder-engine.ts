import type { BacktestResult } from "../types/strategies";
import type { FinderMetric, FinderResult } from "../types/finder";
import type { PolymarketEvalResult } from "../types/polymarket-outcomes";

function isAscendingMetric(metric: FinderMetric): boolean {
    // maxDrawdownPercent, VaR, CVaR, and Ulcer are stored as positive values
    // where smaller is better.
    return metric === "maxDrawdownPercent"
        || metric === "valueAtRisk95"
        || metric === "conditionalValueAtRisk95"
        || metric === "ulcerIndex";
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

function computeProfitFactor(grossProfit: number, grossLoss: number): number {
    if (!Number.isFinite(grossProfit) || grossProfit <= 0) {
        return 0;
    }
    if (!Number.isFinite(grossLoss) || grossLoss <= 0) {
        return Infinity;
    }
    return grossProfit / grossLoss;
}

function normalizeProfitFactorForSort(value: number): number {
    if (!Number.isFinite(value)) {
        return value > 0 ? Number.MAX_SAFE_INTEGER : 0;
    }
    return Math.max(0, value);
}

function getPolymarketProfitFactor(evalResult: PolymarketEvalResult): number {
    if (typeof evalResult.profitFactor === "number") {
        return normalizeProfitFactorForSort(evalResult.profitFactor);
    }

    const grossProfit = typeof evalResult.grossProfit === "number" ? Math.max(0, evalResult.grossProfit) : 0;
    const grossLoss = typeof evalResult.grossLoss === "number" ? Math.max(0, evalResult.grossLoss) : 0;
    return normalizeProfitFactorForSort(computeProfitFactor(grossProfit, grossLoss));
}

function normalizePolymarketSizedNetForSort(value: number | undefined): number {
    if (value === undefined || value === null || Number.isNaN(value)) {
        return -Number.MAX_VALUE;
    }
    if (!Number.isFinite(value)) {
        return value > 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
    }
    return value;
}

function computePolymarketProfitFactorBalance(evalResult: PolymarketEvalResult): number {
    const pricedPredictions = Math.max(
        0,
        Number.isFinite(evalResult.pricedPredictions) ? Number(evalResult.pricedPredictions) : 0
    );
    if (pricedPredictions === 0) {
        return 0;
    }

    const grossProfit = typeof evalResult.grossProfit === "number" ? Math.max(0, evalResult.grossProfit) : 0;
    const grossLoss = typeof evalResult.grossLoss === "number" ? Math.max(0, evalResult.grossLoss) : 0;

    if (grossProfit > 0 || grossLoss > 0) {
        // Shrink tiny-sample payout ratios back toward breakeven (PF=1) so
        // weak edges with huge trade counts do not dominate stronger PF rows.
        const smoothedProfitFactor = computeProfitFactor(grossProfit + 1, grossLoss + 1);
        const confidence = pricedPredictions / (pricedPredictions + 50);
        return Math.max(0, smoothedProfitFactor - 1) * confidence;
    }

    return 0;
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
            case "polyProfitFactor":
                return getPolymarketProfitFactor(item.polymarketEval);
            case "polyProfitFactorBalance":
                return computePolymarketProfitFactorBalance(item.polymarketEval);
            case "polySizedNet":
                return normalizePolymarketSizedNetForSort(item.polymarketEval.sizedNetProfit);
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
        case "entryScore":
            return result.tradeTimingQuality?.entryScore ?? 0;
        case "exitScore":
            return result.tradeTimingQuality?.exitScore ?? 0;
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
        case "polyProfitFactor":
        case "polyProfitFactorBalance":
        case "polySizedNet":
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
