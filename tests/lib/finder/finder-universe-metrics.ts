import type {
    FinderOosVerdict,
    FinderUniverseCandidate,
    FinderUniverseMetric,
    FinderUniverseOosAggregate,
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
    const profitFactors: number[] = [];

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
        profitFactors.push(result.profitFactor);

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
        medianProfitFactor: median(profitFactors),
        medianNetProfit: median(netProfits),
        worstNetProfit: netProfits.length > 0 ? Math.min(...netProfits) : 0,
        bestNetProfit: netProfits.length > 0 ? Math.max(...netProfits) : 0,
    };
}

/**
 * Per-symbol OOS verdict. Mirrors the current-chart gate: pass requires a
 * non-negative OOS net profit and an OOS profit factor of at least 1.0. Too
 * few OOS trades (below the per-symbol floor) is inconclusive, not a failure.
 */
export function computeUniverseSymbolOosVerdict(args: {
    oosNetProfit: number;
    oosProfitFactor: number;
    oosTotalTrades: number;
    minTrades: number;
}): FinderOosVerdict {
    const floor = Math.max(1, args.minTrades);
    if (args.oosTotalTrades < floor) return "inconclusive";
    return args.oosNetProfit >= 0 && args.oosProfitFactor >= 1.0 ? "pass" : "fail";
}

/**
 * Strategy-level OOS summary across all symbols. The verdict compares the OOS
 * profitable-active breadth against the IS baseline:
 * - `fail` when fewer than 30% of active OOS symbols are profitable, or the
 *   OOS breadth collapsed below half the IS breadth (curve-fit signal);
 * - `inconclusive` when too few symbols produced any OOS trades;
 * - `pass` otherwise.
 */
export function computeUniverseOosAggregate(args: {
    symbols: FinderUniverseSymbolResult[];
    isProfitableActiveRatio: number;
    minActiveSymbols: number;
}): FinderUniverseOosAggregate {
    let activeSymbols = 0;
    let profitableSymbols = 0;
    let worstNetProfit = 0;
    for (const symbol of args.symbols) {
        const oos = symbol.oosResult;
        if (!oos || oos.totalTrades <= 0) continue;
        activeSymbols += 1;
        if (oos.netProfit > 0.0001) profitableSymbols += 1;
        worstNetProfit = Math.min(worstNetProfit, oos.netProfit);
    }
    const profitableActiveRatio = activeSymbols > 0 ? profitableSymbols / activeSymbols : 0;

    let verdict: FinderOosVerdict;
    if (activeSymbols < Math.max(1, args.minActiveSymbols)) {
        verdict = "inconclusive";
    } else if (profitableActiveRatio < 0.3 || profitableActiveRatio < args.isProfitableActiveRatio * 0.5) {
        verdict = "fail";
    } else {
        verdict = "pass";
    }
    return { verdict, activeSymbols, profitableSymbols, profitableActiveRatio, worstNetProfit };
}

export function buildFinderUniverseCandidate(input: {
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    symbols: FinderUniverseSymbolResult[];
    evaluationStoppedEarly?: boolean;
    stoppedReason?: FinderUniverseCandidate["stoppedReason"];
    exitStrategyKey?: string;
    exitStrategyName?: string;
    exitStrategyParams?: StrategyParams;
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
        ...(input.exitStrategyKey
            ? {
                exitStrategyKey: input.exitStrategyKey,
                exitStrategyName: input.exitStrategyName,
                exitStrategyParams: input.exitStrategyParams,
            }
            : {}),
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
        case "medianProfitFactor":
            return item.medianProfitFactor;
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
