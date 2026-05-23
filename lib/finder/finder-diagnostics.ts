import type { FinderDiagnostics, FinderMode, FinderStrategyDiagnostics } from "../types/finder";

export type FinderDiagnosticsTimings = FinderDiagnostics["timingsMs"];

export type FinderStrategyDiagnosticsStats = {
    key: string;
    name: string;
    runs: number;
    failedRuns: number;
    signalMs: number;
    backtestMs: number;
    totalMs: number;
    usedPreparedData: boolean;
};

export function createEmptyFinderDiagnosticsTimings(): FinderDiagnosticsTimings {
    return {
        total: 0,
        paramGeneration: 0,
        dataLoading: 0,
        pricePointLoading: 0,
        closedDataSelection: 0,
        indicatorPrecompute: 0,
        preparedData: 0,
        signalGeneration: 0,
        backtest: 0,
        polymarketEvaluation: 0,
        rustRequest: 0,
        resultEnrichment: 0,
        resultRanking: 0,
        reconciliation: 0,
        uiUpdates: 0,
        yielding: 0,
    };
}

export function createFinderRunId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function roundFinderMs(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

export function addElapsed(
    timings: FinderDiagnosticsTimings,
    key: keyof FinderDiagnosticsTimings,
    startedAt: number
): void {
    timings[key] += performance.now() - startedAt;
}

export function getFinderStrategyDiagnosticsStats(
    statsByKey: Map<string, FinderStrategyDiagnosticsStats>,
    item: { key: string; name: string }
): FinderStrategyDiagnosticsStats {
    let stats = statsByKey.get(item.key);
    if (!stats) {
        stats = {
            key: item.key,
            name: item.name,
            runs: 0,
            failedRuns: 0,
            signalMs: 0,
            backtestMs: 0,
            totalMs: 0,
            usedPreparedData: false,
        };
        statsByKey.set(item.key, stats);
    }
    return stats;
}

export function toFinderStrategyDiagnostics(
    statsByKey: Map<string, FinderStrategyDiagnosticsStats>
): FinderStrategyDiagnostics[] {
    return [...statsByKey.values()]
        .map((stats) => ({
            key: stats.key,
            name: stats.name,
            runs: stats.runs,
            failedRuns: stats.failedRuns,
            avgSignalMs: roundFinderMs(stats.signalMs / Math.max(1, stats.runs)),
            avgBacktestMs: roundFinderMs(stats.backtestMs / Math.max(1, stats.runs)),
            avgTotalMs: roundFinderMs(stats.totalMs / Math.max(1, stats.runs)),
            usedPreparedData: stats.usedPreparedData,
        }))
        .sort((a, b) => b.avgTotalMs - a.avgTotalMs);
}

export function buildFinderDiagnosticsBottlenecks(args: {
    timingsMs: FinderDiagnosticsTimings;
    strategyBreakdown: FinderStrategyDiagnostics[];
    failedRuns: number;
    rustFallbackRuns?: number;
}): string[] {
    const phases = [
        { label: "data loading", value: args.timingsMs.dataLoading },
        { label: "price point loading", value: args.timingsMs.pricePointLoading },
        { label: "signal generation", value: args.timingsMs.signalGeneration },
        { label: "backtest", value: args.timingsMs.backtest },
        { label: "Polymarket evaluation", value: args.timingsMs.polymarketEvaluation },
        { label: "Rust request", value: args.timingsMs.rustRequest },
        { label: "result ranking", value: args.timingsMs.resultRanking },
        { label: "UI updates", value: args.timingsMs.uiUpdates },
        { label: "yielding", value: args.timingsMs.yielding },
    ].filter((phase) => phase.value > 0)
        .sort((a, b) => b.value - a.value);

    const notes: string[] = [];
    const total = Math.max(1, args.timingsMs.total);
    for (const phase of phases.slice(0, 3)) {
        const pct = (phase.value / total) * 100;
        if (pct >= 10) {
            notes.push(`${phase.label} used ${pct.toFixed(1)}% of runtime`);
        }
    }

    const slowestStrategy = args.strategyBreakdown[0];
    if (slowestStrategy && slowestStrategy.avgTotalMs >= 5) {
        notes.push(`${slowestStrategy.key} was the slowest strategy at ${slowestStrategy.avgTotalMs.toFixed(2)} ms/run`);
    }
    if ((args.rustFallbackRuns ?? 0) > 0) {
        notes.push(`${args.rustFallbackRuns} Rust run${args.rustFallbackRuns === 1 ? "" : "s"} fell back to TypeScript`);
    }
    if (args.failedRuns > 0) {
        notes.push(`${args.failedRuns} candidate run${args.failedRuns === 1 ? "" : "s"} failed`);
    }
    return notes.length > 0 ? notes : ["No single phase exceeded 10% of total runtime"];
}

export function buildFinderDiagnostics(args: {
    runId: string;
    symbol: string;
    interval: string;
    mode: FinderMode;
    engineMode: string;
    inputBars: number;
    evaluationBars: number;
    selectedStrategies: number;
    totalParamRuns: number;
    batchSize: number;
    processedRuns: number;
    filteredRuns: number;
    shownResults: number;
    endpointAdjusted: number;
    failedRuns: number;
    timings: FinderDiagnosticsTimings;
    strategyBreakdown: FinderStrategyDiagnostics[];
    rustCompletedRuns?: number;
    rustFallbackRuns?: number;
}): FinderDiagnostics {
    const timingsMs: FinderDiagnosticsTimings = {
        total: roundFinderMs(args.timings.total),
        paramGeneration: roundFinderMs(args.timings.paramGeneration),
        dataLoading: roundFinderMs(args.timings.dataLoading),
        pricePointLoading: roundFinderMs(args.timings.pricePointLoading),
        closedDataSelection: roundFinderMs(args.timings.closedDataSelection),
        indicatorPrecompute: roundFinderMs(args.timings.indicatorPrecompute),
        preparedData: roundFinderMs(args.timings.preparedData),
        signalGeneration: roundFinderMs(args.timings.signalGeneration),
        backtest: roundFinderMs(args.timings.backtest),
        polymarketEvaluation: roundFinderMs(args.timings.polymarketEvaluation),
        rustRequest: roundFinderMs(args.timings.rustRequest),
        resultEnrichment: roundFinderMs(args.timings.resultEnrichment),
        resultRanking: roundFinderMs(args.timings.resultRanking),
        reconciliation: roundFinderMs(args.timings.reconciliation),
        uiUpdates: roundFinderMs(args.timings.uiUpdates),
        yielding: roundFinderMs(args.timings.yielding),
    };
    return {
        runId: args.runId,
        symbol: args.symbol,
        interval: args.interval,
        mode: args.mode,
        engineMode: args.engineMode,
        data: {
            inputBars: args.inputBars,
            evaluationBars: args.evaluationBars,
            selectedStrategies: args.selectedStrategies,
            totalParamRuns: args.totalParamRuns,
            batchSize: args.batchSize,
        },
        counts: {
            processedRuns: args.processedRuns,
            filteredRuns: args.filteredRuns,
            shownResults: args.shownResults,
            rustCompletedRuns: args.rustCompletedRuns ?? 0,
            rustFallbackRuns: args.rustFallbackRuns ?? 0,
            endpointAdjusted: args.endpointAdjusted,
            failedRuns: args.failedRuns,
        },
        timingsMs,
        strategyBreakdown: args.strategyBreakdown,
        bottlenecks: buildFinderDiagnosticsBottlenecks({
            timingsMs,
            strategyBreakdown: args.strategyBreakdown,
            failedRuns: args.failedRuns,
            rustFallbackRuns: args.rustFallbackRuns,
        }),
    };
}
