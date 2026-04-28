import type {
    FinderUniverseCandidate,
    FinderUniverseMetric,
    FinderUniverseOptions,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type { StrategyParams } from "../types/strategies";

function median(values: readonly number[]): number {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const midpoint = Math.floor(sorted.length / 2);
    if ((sorted.length & 1) === 1) {
        return sorted[midpoint] ?? 0;
    }
    return ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2;
}

function isAscendingUniverseMetric(_metric: FinderUniverseMetric): boolean {
    return false;
}

function classifyCounts(symbols: readonly FinderUniverseSymbolResult[]) {
    let activeSymbols = 0;
    let profitableSymbols = 0;
    let losingSymbols = 0;
    let flatSymbols = 0;
    let noTradeSymbols = 0;
    let totalTrades = 0;
    const expectancies: number[] = [];
    const netProfits: number[] = [];

    for (const symbol of symbols) {
        const result = symbol.result;
        if (!result) {
            if (symbol.status === "no_trades") {
                noTradeSymbols += 1;
            }
            continue;
        }

        if (result.totalTrades <= 0) {
            noTradeSymbols += 1;
            continue;
        }

        activeSymbols += 1;
        totalTrades += result.totalTrades;
        expectancies.push(result.expectancy);
        netProfits.push(result.netProfit);

        if (result.netProfit > 0.0001) {
            profitableSymbols += 1;
        } else if (result.netProfit < -0.0001) {
            losingSymbols += 1;
        } else {
            flatSymbols += 1;
        }
    }

    return {
        activeSymbols,
        profitableSymbols,
        losingSymbols,
        flatSymbols,
        noTradeSymbols,
        totalTrades,
        medianExpectancy: median(expectancies),
        medianNetProfit: median(netProfits),
        worstNetProfit: netProfits.length > 0 ? Math.min(...netProfits) : 0,
        bestNetProfit: netProfits.length > 0 ? Math.max(...netProfits) : 0,
    };
}

export function buildFinderUniverseCandidate(input: {
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    symbols: FinderUniverseSymbolResult[];
    evaluationStoppedEarly?: boolean;
    stoppedReason?: FinderUniverseCandidate["stoppedReason"];
}): FinderUniverseCandidate {
    const counts = classifyCounts(input.symbols);
    return {
        strategyKey: input.strategyKey,
        strategyName: input.strategyName,
        params: input.params,
        symbols: [...input.symbols],
        ...counts,
        profitableActiveRatio: counts.activeSymbols > 0
            ? counts.profitableSymbols / counts.activeSymbols
            : 0,
        evaluationStoppedEarly: input.evaluationStoppedEarly,
        stoppedReason: input.stoppedReason,
    };
}

export function getFinderUniverseMetricValue(
    item: FinderUniverseCandidate,
    metric: FinderUniverseMetric
): number {
    switch (metric) {
        case "profitableActiveRatio":
            return item.profitableActiveRatio;
        case "activeSymbols":
            return item.activeSymbols;
        case "medianExpectancy":
            return item.medianExpectancy;
        case "worstNetProfit":
            return item.worstNetProfit;
        case "totalTrades":
            return item.totalTrades;
        default:
            return 0;
    }
}

export function compareFinderUniverseCandidates(
    left: FinderUniverseCandidate,
    right: FinderUniverseCandidate,
    sortPriority: readonly FinderUniverseMetric[]
): number {
    for (const metric of sortPriority) {
        const leftValue = getFinderUniverseMetricValue(left, metric);
        const rightValue = getFinderUniverseMetricValue(right, metric);
        if (Math.abs(leftValue - rightValue) > 0.0001) {
            return isAscendingUniverseMetric(metric)
                ? leftValue - rightValue
                : rightValue - leftValue;
        }
    }

    if (left.strategyName !== right.strategyName) {
        return left.strategyName.localeCompare(right.strategyName);
    }

    return JSON.stringify(left.params).localeCompare(JSON.stringify(right.params));
}

export function sortFinderUniverseCandidates(
    results: readonly FinderUniverseCandidate[],
    sortPriority: readonly FinderUniverseMetric[]
): FinderUniverseCandidate[] {
    return [...results].sort((left, right) => compareFinderUniverseCandidates(left, right, sortPriority));
}

export function passesFinderUniverseFilters(
    candidate: FinderUniverseCandidate,
    universe: FinderUniverseOptions
): boolean {
    return candidate.activeSymbols >= universe.minActiveSymbols
        && candidate.totalTrades >= universe.minTotalTrades
        && candidate.profitableActiveRatio >= universe.minProfitableActiveRatio;
}
