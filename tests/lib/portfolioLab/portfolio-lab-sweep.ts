import { backtestService } from "../backtest-service";
import { timeKey, type BacktestResult, type OHLCVData, type Signal, type Strategy, type StrategyParams } from "../strategies";
import { uiManager } from "../ui-manager";
import { MIN_LOOKBACK_BARS, type BreadthSweepRow, type ExecutionFilter, type ExecutionFilterRun, type OppositionSweepRow, type PairRunArtifacts, type PortfolioCapitalSettings, type PortfolioEngineUsed, type PortfolioRunContext, type SignalContext } from "./portfolio-lab-types";
import { resolveLatestPortfolioSignalType, resolvePortfolioSignalType } from "./portfolio-lab-helpers";

export interface PortfolioSweepDependencies {
    runPair: (
        strategy: Strategy,
        params: StrategyParams,
        symbol: string,
        data: OHLCVData[],
        runCache: Map<string, PairRunArtifacts>,
        settings: PortfolioRunContext["settings"],
        capitalSettings: PortfolioCapitalSettings
    ) => Promise<PairRunArtifacts>;
}

export async function buildBreadthSweepRows(
    context: PortfolioRunContext,
    dependencies: PortfolioSweepDependencies
): Promise<BreadthSweepRow[]> {
    const maxAgree = Math.max(0, context.selectedSymbols.length - (context.selectedSymbols.includes(context.benchmarkSymbol) ? 1 : 0));
    const rows: BreadthSweepRow[] = [];

    for (let minAgree = 0; minAgree <= maxAgree; minAgree += 1) {
        const breadthRun = await buildFilterRun(context, { minAgree, maxOppose: null }, dependencies);
        if (breadthRun) {
            rows.push({
                minAgree,
                signals: breadthRun.signals,
                result: breadthRun.result,
                engineUsed: breadthRun.engineUsed,
            });
        }
    }

    return rows;
}

export async function buildOppositionSweepRows(
    context: PortfolioRunContext,
    minAgree: number,
    _maxOpposeHint: number,
    dependencies: PortfolioSweepDependencies
): Promise<OppositionSweepRow[]> {
    const maxOppose = Math.max(0, context.selectedSymbols.length - (context.selectedSymbols.includes(context.benchmarkSymbol) ? 1 : 0));
    const rows: OppositionSweepRow[] = [];

    for (let threshold = 0; threshold <= maxOppose; threshold += 1) {
        const filterRun = await buildFilterRun(context, { minAgree, maxOppose: threshold }, dependencies);
        if (filterRun) {
            rows.push({
                maxOppose: threshold,
                signals: filterRun.signals,
                result: filterRun.result,
                engineUsed: filterRun.engineUsed,
            });
        }
    }

    return rows;
}

export async function buildFilterRun(
    context: PortfolioRunContext,
    filter: ExecutionFilter,
    dependencies: PortfolioSweepDependencies
): Promise<ExecutionFilterRun | null> {
    const targetSymbol = context.benchmarkSymbol;
    const targetData = context.dataCache.get(targetSymbol)?.data;
    if (!targetData || targetData.length < MIN_LOOKBACK_BARS) {
        uiManager.showToast(`No usable data for breadth backtest on ${targetSymbol}.`, "error");
        return null;
    }

    const targetArtifacts = context.runCache.get(targetSymbol)
        ?? await dependencies.runPair(
            context.strategy,
            context.params,
            targetSymbol,
            targetData,
            context.runCache,
            context.settings,
            context.capitalSettings
        );

    const signalContexts = buildSignalContexts(
        targetSymbol,
        targetArtifacts,
        context.runCache,
        context.lagBars
    );
    const filteredSignals = buildFilteredSignals(targetArtifacts, signalContexts, filter);
    if (filteredSignals.length === 0) {
        return null;
    }

    const runResult = await backtestService.evaluateSignalsOnData(
        targetData,
        context.interval,
        filteredSignals,
        context.settings,
        context.capitalSettings
    );

    return {
        filter,
        signals: filteredSignals.length,
        result: runResult.result,
        engineUsed: runResult.engineUsed as PortfolioEngineUsed,
    };
}

export function buildFilteredSignals(
    targetArtifacts: PairRunArtifacts,
    signalContexts: Map<string, SignalContext>,
    filter: ExecutionFilter
): Signal[] {
    const filtered: Signal[] = [];

    for (const signal of targetArtifacts.fullSignals) {
        const context = signalContexts.get(buildSignalContextKey(timeKey(signal.time), signal.type));
        if (!context) {
            continue;
        }
        if (context.sameCount < filter.minAgree) {
            continue;
        }
        if (typeof filter.maxOppose === "number" && context.oppositeCount > filter.maxOppose) {
            continue;
        }
        filtered.push(signal);
    }

    return filtered;
}

export function buildSignalContexts(
    targetSymbol: string,
    targetArtifacts: PairRunArtifacts,
    artifactsBySymbol: Map<string, PairRunArtifacts>,
    lagBars: number
): Map<string, SignalContext> {
    const contexts = new Map<string, SignalContext>();

    for (const [timeKeyValue, signalPresence] of targetArtifacts.signalPresenceByTime.entries()) {
        const signalType = resolvePortfolioSignalType(signalPresence);
        if (!signalType) {
            continue;
        }
        const entryIndex = targetArtifacts.timeIndex.get(timeKeyValue);
        if (entryIndex === undefined) {
            continue;
        }

        const startIndex = Math.max(0, entryIndex - lagBars);
        const windowKeys = targetArtifacts.timeKeys.slice(startIndex, entryIndex + 1);
        let sameCount = 0;
        let oppositeCount = 0;
        const agreeingSymbols: string[] = [];
        const opposingSymbols: string[] = [];

        for (const [symbol, artifacts] of artifactsBySymbol.entries()) {
            if (symbol === targetSymbol) {
                continue;
            }

            const latestType = resolveLatestPortfolioSignalType(windowKeys, artifacts.signalPresenceByTime);
            if (latestType === signalType) {
                sameCount += 1;
                agreeingSymbols.push(symbol);
            } else if (latestType) {
                oppositeCount += 1;
                opposingSymbols.push(symbol);
            }
        }

        contexts.set(buildSignalContextKey(timeKeyValue, signalType), {
            timeKey: timeKeyValue,
            signalType,
            sameCount,
            oppositeCount,
            agreeingSymbols,
            opposingSymbols,
        });
    }

    return contexts;
}

export function buildSignalContextKey(timeValue: string, signalType: Signal["type"]): string {
    return `${timeValue}|${signalType}`;
}

export function renderBestBreadthSweep(rows: BreadthSweepRow[]): BreadthSweepRow | null {
    return rows
        .slice()
        .sort((a, b) => {
            if (b.result.expectancy !== a.result.expectancy) {
                return b.result.expectancy - a.result.expectancy;
            }
            return b.result.netProfitPercent - a.result.netProfitPercent;
        })[0] ?? null;
}

export function renderBestOppositionSweep(rows: OppositionSweepRow[]): OppositionSweepRow | null {
    return rows
        .slice()
        .sort((a, b) => {
            if (b.result.expectancy !== a.result.expectancy) {
                return b.result.expectancy - a.result.expectancy;
            }
            return b.result.netProfitPercent - a.result.netProfitPercent;
        })[0] ?? null;
}

export function collapseOppositionSweepRows(rows: OppositionSweepRow[]): Array<{ label: string; row: OppositionSweepRow }> {
    if (rows.length === 0) {
        return [];
    }

    const collapsed: Array<{ start: number; end: number; row: OppositionSweepRow }> = [];
    for (const row of rows) {
        const last = collapsed[collapsed.length - 1];
        if (last && isEquivalentSweepResult(last.row.result, row.result) && last.row.signals === row.signals) {
            last.end = row.maxOppose;
        } else {
            collapsed.push({ start: row.maxOppose, end: row.maxOppose, row });
        }
    }

    return collapsed.map((entry) => ({
        label: entry.start === entry.end ? `${entry.start}` : `${entry.start}+`,
        row: entry.row,
    }));
}

export function isEquivalentSweepResult(a: BacktestResult, b: BacktestResult): boolean {
    return a.totalTrades === b.totalTrades
        && Math.abs(a.netProfitPercent - b.netProfitPercent) < 0.0001
        && Math.abs(a.expectancy - b.expectancy) < 0.0001
        && Math.abs(a.profitFactor - b.profitFactor) < 0.0001
        && Math.abs(a.maxDrawdownPercent - b.maxDrawdownPercent) < 0.0001
        && Math.abs(a.winRate - b.winRate) < 0.0001;
}

export function findBestFilterRun(
    _breadthRows: BreadthSweepRow[],
    oppositionRows: OppositionSweepRow[],
    minAgree: number,
    maxOppose: number
): ExecutionFilterRun | null {
    const current = oppositionRows.find((row) => row.maxOppose === maxOppose);
    if (!current) {
        return null;
    }
    return {
        filter: { minAgree, maxOppose },
        signals: current.signals,
        result: current.result,
        engineUsed: current.engineUsed,
    };
}

export function findSweepWinner<T extends BreadthSweepRow | OppositionSweepRow>(
    rows: T[],
    score: (row: T) => number,
    label: (row: T) => string
): { label: string; result: BacktestResult } | null {
    if (rows.length === 0) {
        return null;
    }
    const winner = rows
        .slice()
        .sort((a, b) => {
            const delta = score(b) - score(a);
            if (delta !== 0) {
                return delta;
            }
            return b.result.expectancy - a.result.expectancy;
        })[0];
    return winner ? { label: label(winner), result: winner.result } : null;
}
