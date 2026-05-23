import type { BacktestDiagnostics } from "../types/strategies";
import type {
    FinderBacktestDiagnostics,
    FinderDiagnostics,
    FinderFailureDiagnostics,
    FinderFailureReasonDiagnostics,
    FinderMode,
    FinderStrategyDiagnostics,
} from "../types/finder";

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
    backtest: FinderBacktestDiagnosticsStats;
    failureReasons: Map<string, number>;
};

export type FinderBacktestDiagnosticsStats = {
    runs: number;
    timingsMs: FinderBacktestDiagnostics["timingsMs"];
    totals: FinderBacktestDiagnostics["totals"];
    fastPathBlockers: Map<string, number>;
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

export function createEmptyFinderBacktestDiagnosticsStats(): FinderBacktestDiagnosticsStats {
    return {
        runs: 0,
        totals: {
            inputBars: 0,
            evaluationBars: 0,
            inputSignals: 0,
            preparedSignals: 0,
            barsScanned: 0,
            barsWithPosition: 0,
            entriesAttempted: 0,
            tradesOpened: 0,
            tradesClosed: 0,
            signalExitOrders: 0,
            forcedEndOfDataExits: 0,
            fastPathRuns: 0,
            maxOpenPositions: 0,
        },
        timingsMs: {
            total: 0,
            dataClean: 0,
            indicatorResolution: 0,
            signalPreparation: 0,
            signalIndexing: 0,
            entryEvaluation: 0,
            tradeSimulation: 0,
            forcedClose: 0,
            drawdown: 0,
            metrics: 0,
        },
        fastPathBlockers: new Map(),
    };
}

export function createFinderRunId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function roundFinderMs(value: number): number {
    return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function roundFinderCount(value: number): number {
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
            backtest: createEmptyFinderBacktestDiagnosticsStats(),
            failureReasons: new Map(),
        };
        statsByKey.set(item.key, stats);
    }
    return stats;
}

function normalizeFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? "unknown failure");
    return message.replace(/\s+/g, " ").trim().slice(0, 220) || "unknown failure";
}

export function recordFinderStrategyFailure(
    stats: FinderStrategyDiagnosticsStats,
    error?: unknown,
    count = 1
): void {
    const reason = normalizeFailureReason(error);
    stats.failureReasons.set(reason, (stats.failureReasons.get(reason) ?? 0) + Math.max(1, Math.round(count)));
}

export function recordFinderBacktestDiagnostics(
    target: FinderBacktestDiagnosticsStats,
    diagnostics: BacktestDiagnostics | undefined
): void {
    if (!diagnostics) return;
    target.runs++;
    for (const key of Object.keys(target.totals) as Array<keyof FinderBacktestDiagnostics["totals"]>) {
        if (key === "maxOpenPositions") {
            target.totals.maxOpenPositions = Math.max(target.totals.maxOpenPositions, diagnostics.counts.maxOpenPositions);
            continue;
        }
        target.totals[key] += diagnostics.counts[key] ?? 0;
    }
    for (const key of Object.keys(target.timingsMs) as Array<keyof FinderBacktestDiagnostics["timingsMs"]>) {
        target.timingsMs[key] += diagnostics.timingsMs[key] ?? 0;
    }
    if (diagnostics.fastPath && !diagnostics.fastPath.used) {
        for (const blocker of diagnostics.fastPath.blockers) {
            target.fastPathBlockers.set(blocker, (target.fastPathBlockers.get(blocker) ?? 0) + 1);
        }
    }
}

function toFailureReasonDiagnostics(reasons: Map<string, number>): FinderFailureReasonDiagnostics[] | undefined {
    if (reasons.size === 0) return undefined;
    return [...reasons.entries()]
        .map(([reason, runs]) => ({ reason, runs }))
        .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason));
}

export function toFinderFailureDiagnostics(
    statsByKey: Map<string, FinderStrategyDiagnosticsStats>
): FinderFailureDiagnostics[] | undefined {
    const byReason = new Map<string, { runs: number; strategyKeys: Set<string> }>();
    for (const stats of statsByKey.values()) {
        for (const [reason, runs] of stats.failureReasons) {
            let entry = byReason.get(reason);
            if (!entry) {
                entry = { runs: 0, strategyKeys: new Set() };
                byReason.set(reason, entry);
            }
            entry.runs += runs;
            entry.strategyKeys.add(stats.key);
        }
    }
    if (byReason.size === 0) return undefined;
    return [...byReason.entries()]
        .map(([reason, entry]) => ({
            reason,
            runs: entry.runs,
            strategyKeys: [...entry.strategyKeys].sort(),
        }))
        .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason));
}

export function toFinderBacktestDiagnostics(
    stats: FinderBacktestDiagnosticsStats
): FinderBacktestDiagnostics | undefined {
    if (stats.runs === 0) return undefined;
    const runs = Math.max(1, stats.runs);
    const timingsMs = { ...stats.timingsMs };
    for (const key of Object.keys(timingsMs) as Array<keyof FinderBacktestDiagnostics["timingsMs"]>) {
        timingsMs[key] = roundFinderMs(timingsMs[key]);
    }
    return {
        runs: stats.runs,
        avgInputSignals: roundFinderCount(stats.totals.inputSignals / runs),
        avgPreparedSignals: roundFinderCount(stats.totals.preparedSignals / runs),
        avgBarsScanned: roundFinderCount(stats.totals.barsScanned / runs),
        avgBarsWithPosition: roundFinderCount(stats.totals.barsWithPosition / runs),
        avgEntriesAttempted: roundFinderCount(stats.totals.entriesAttempted / runs),
        avgTradesOpened: roundFinderCount(stats.totals.tradesOpened / runs),
        avgTradesClosed: roundFinderCount(stats.totals.tradesClosed / runs),
        fastPathRuns: stats.totals.fastPathRuns,
        fastPathBlockers: toFailureReasonDiagnostics(stats.fastPathBlockers),
        maxOpenPositions: stats.totals.maxOpenPositions,
        totals: { ...stats.totals },
        timingsMs,
    };
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
            backtest: toFinderBacktestDiagnostics(stats.backtest),
            failureReasons: toFailureReasonDiagnostics(stats.failureReasons),
        }))
        .sort((a, b) => b.avgTotalMs - a.avgTotalMs);
}

export function buildFinderDiagnosticsBottlenecks(args: {
    timingsMs: FinderDiagnosticsTimings;
    strategyBreakdown: FinderStrategyDiagnostics[];
    failedRuns: number;
    rustFallbackRuns?: number;
    backtest?: FinderBacktestDiagnostics;
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
    if (args.backtest && args.backtest.runs > 0) {
        const backtestPhases = [
            { label: "trade simulation", value: args.backtest.timingsMs.tradeSimulation },
            { label: "metrics", value: args.backtest.timingsMs.metrics },
            { label: "entry evaluation", value: args.backtest.timingsMs.entryEvaluation },
            { label: "signal preparation", value: args.backtest.timingsMs.signalPreparation },
            { label: "indicator resolution", value: args.backtest.timingsMs.indicatorResolution },
            { label: "drawdown", value: args.backtest.timingsMs.drawdown },
            { label: "forced close", value: args.backtest.timingsMs.forcedClose },
        ].filter((phase) => phase.value > 0)
            .sort((a, b) => b.value - a.value);
        const slowestBacktestPhase = backtestPhases[0];
        if (slowestBacktestPhase && args.backtest.timingsMs.total > 0) {
            const pct = (slowestBacktestPhase.value / args.backtest.timingsMs.total) * 100;
            if (pct >= 10) {
                notes.push(`backtest ${slowestBacktestPhase.label} used ${pct.toFixed(1)}% of measured backtest time`);
            }
        }
        const fastPathRuns = args.backtest.fastPathRuns ?? 0;
        const topFastPathBlocker = args.backtest.fastPathBlockers?.[0];
        if (fastPathRuns < args.backtest.runs && topFastPathBlocker) {
            notes.push(`backtest fast path skipped ${args.backtest.runs - fastPathRuns} run${args.backtest.runs - fastPathRuns === 1 ? "" : "s"}; top reason: ${topFastPathBlocker.reason}`);
        }
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
    backtestDiagnostics?: FinderBacktestDiagnostics;
    failureBreakdown?: FinderFailureDiagnostics[];
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
        backtest: args.backtestDiagnostics,
        failureBreakdown: args.failureBreakdown,
        timingsMs,
        strategyBreakdown: args.strategyBreakdown,
        bottlenecks: buildFinderDiagnosticsBottlenecks({
            timingsMs,
            strategyBreakdown: args.strategyBreakdown,
            failedRuns: args.failedRuns,
            rustFallbackRuns: args.rustFallbackRuns,
            backtest: args.backtestDiagnostics,
        }),
    };
}
