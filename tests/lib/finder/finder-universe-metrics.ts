import type {
    FinderUniverseCandidate,
    FinderUniverseMetric,
    FinderUniverseOptions,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type { StrategyParams } from "../types/strategies";
import { median } from "../statistics-utils";

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
    const sharpes: number[] = [];

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
        sharpes.push(result.sharpeRatio);

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
        medianSharpe: median(sharpes),
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
        case "medianSharpe":
            return item.medianSharpe;
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

export interface SymbolVerdict {
    label: string;
    cssClass: string;
    tier: number;
}

export function computePerformanceVerdict(
    result: { netProfit: number; profitFactor: number; totalTrades: number; sharpeRatio: number } | undefined,
    status: string
): SymbolVerdict {
    if (!result || result.totalTrades <= 0 ||
        status === "no_trades" || status === "load_failed" || status === "run_failed") {
        return { label: "NO SIGNAL", cssClass: "finder-verdict-no-signal", tier: 6 };
    }
    if (result.totalTrades < 15) {
        return { label: "THIN", cssClass: "finder-verdict-thin", tier: 5 };
    }
    if (result.netProfit < 0) {
        return { label: "LOSING", cssClass: "finder-verdict-losing", tier: 4 };
    }
    const pf = result.profitFactor;
    const sharpe = result.sharpeRatio;
    if (pf >= 1.5 && sharpe >= 1.0) {
        return { label: "STRONG", cssClass: "finder-verdict-strong", tier: 0 };
    }
    if (pf >= 1.2 && sharpe >= 0.5) {
        return { label: "SOLID", cssClass: "finder-verdict-solid", tier: 1 };
    }
    if (pf >= 1.05) {
        return { label: "MARGINAL", cssClass: "finder-verdict-marginal", tier: 2 };
    }
    return { label: "WEAK", cssClass: "finder-verdict-weak", tier: 3 };
}

export interface StrategyVerdict {
    label: string;
    cssClass: string;
}

export function computeStrategyVerdict(ratio: number): StrategyVerdict {
    if (ratio >= 1.0) return { label: "UNIFORM — check directional bias", cssClass: "finder-verdict-uniform" };
    if (ratio >= 0.85) return { label: "BROAD EDGE", cssClass: "finder-verdict-strong" };
    if (ratio >= 0.65) return { label: "MODERATE", cssClass: "finder-verdict-solid" };
    if (ratio >= 0.45) return { label: "SELECTIVE", cssClass: "finder-verdict-marginal" };
    return { label: "NARROW", cssClass: "finder-verdict-weak" };
}
