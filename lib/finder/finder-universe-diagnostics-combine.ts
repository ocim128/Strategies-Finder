/**
 * Server-safe combination of per-strategy `FinderDiagnostics` into one
 * job-level diagnostics object for a multi-strategy Universe run.
 *
 * Extracted verbatim from the prior private methods on `FinderManager`
 * (`combineFailureBreakdown`, `combineUniverseStrategyBreakdown`,
 * `combineUniverseDiagnostics`, `buildCombinedUniverseDiagnostics`) so the
 * server-owned job can merge per-strategy diagnostics without importing the
 * browser-bound `FinderManager`. Pure + leaf: only type imports from
 * `../types/finder` and the existing `./finder-diagnostics` builders.
 *
 * Determinism contract: the merge is order-independent (Maps + sorted output),
 * so the combined diagnostics are identical regardless of per-strategy
 * execution order. This preserves the prior browser-side combination
 * semantics for fixture parity.
 */

import {
    buildFinderDiagnostics,
    createEmptyFinderBacktestDiagnosticsStats,
    createEmptyFinderDiagnosticsTimings,
    createFinderRunId,
    toFinderBacktestDiagnostics,
    type FinderDiagnosticsTimings,
} from "./finder-diagnostics";
import type {
    FinderDiagnostics,
    FinderFailureDiagnostics,
    FinderMode,
    FinderOptions,
    FinderStrategyDiagnostics,
    FinderUniverseMetric,
} from "../types/finder";

/**
 * Combine per-strategy `failureBreakdown` arrays into one de-duplicated,
 * reason-bucketed list. Failures for the same reason across strategies have
 * their `runs` summed and `strategyKeys` unioned.
 */
export function combineUniverseFailureBreakdown(
    parts: readonly FinderDiagnostics[],
): FinderFailureDiagnostics[] | undefined {
    const byReason = new Map<string, { runs: number; strategyKeys: Set<string> }>();
    for (const part of parts) {
        for (const failure of part.failureBreakdown ?? []) {
            let entry = byReason.get(failure.reason);
            if (!entry) {
                entry = { runs: 0, strategyKeys: new Set<string>() };
                byReason.set(failure.reason, entry);
            }
            entry.runs += failure.runs;
            failure.strategyKeys.forEach((key) => entry!.strategyKeys.add(key));
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

/**
 * Concatenate per-strategy `strategyBreakdown` arrays and recompute
 * `runtimePct` against the combined total runtime.
 */
export function combineUniverseStrategyBreakdown(
    parts: readonly FinderDiagnostics[],
): FinderStrategyDiagnostics[] {
    const strategyBreakdown = parts.flatMap((part) => part.strategyBreakdown);
    const totalMs = strategyBreakdown.reduce((sum, strategy) => sum + strategy.totalMs, 0);
    return strategyBreakdown
        .map((strategy) => ({
            ...strategy,
            runtimePct: totalMs > 0 ? Number(((strategy.totalMs / totalMs) * 100).toFixed(2)) : 0,
        }))
        .sort((a, b) => b.avgTotalMs - a.avgTotalMs);
}

/** Combine per-strategy backtest counters without averaging averages. */
export function combineUniverseBacktestDiagnostics(parts: readonly FinderDiagnostics[]): FinderDiagnostics["backtest"] {
    const stats = createEmptyFinderBacktestDiagnosticsStats();
    for (const backtest of parts.map((part) => part.backtest).filter(Boolean)) {
        if (!backtest) continue;
        stats.runs += backtest.runs;
        // Per-strategy totals are already projected from any diagnostic
        // sampling, so treat every combined run as measured to avoid scaling
        // them a second time.
        stats.sampledRuns += backtest.runs;
        for (const key of Object.keys(stats.totals) as Array<keyof typeof stats.totals>) {
            if (key === "maxOpenPositions") {
                stats.totals.maxOpenPositions = Math.max(stats.totals.maxOpenPositions, backtest.totals.maxOpenPositions);
            } else {
                stats.totals[key] += backtest.totals[key];
            }
        }
        for (const key of Object.keys(stats.timingsMs) as Array<keyof typeof stats.timingsMs>) {
            stats.timingsMs[key] += backtest.timingsMs[key];
        }
        for (const blocker of backtest.fastPathBlockers ?? []) {
            stats.fastPathBlockers.set(
                blocker.reason,
                (stats.fastPathBlockers.get(blocker.reason) ?? 0) + blocker.runs,
            );
        }
    }
    return toFinderBacktestDiagnostics(stats);
}

/**
 * Merge per-strategy `universe` diagnostics blocks. `totalSymbols` /
 * `loadedSymbols` are the max across strategies (each strategy loads the same
 * universe); `failedSymbols` are unioned by symbol (first reason wins). The
 * `dataWindow` is taken from the last strategy that populated it (the prior
 * browser behavior preserved verbatim).
 */
export function combineUniverseDiagnosticsBlock(
    parts: readonly FinderDiagnostics[],
): FinderDiagnostics["universe"] | undefined {
    const universeParts = parts
        .map((part) => part.universe)
        .filter((universe): universe is NonNullable<FinderDiagnostics["universe"]> => Boolean(universe));
    if (universeParts.length === 0) return undefined;

    const failedSymbols = new Map<string, string>();
    const typescriptReasons = new Map<string, number>();
    for (const universe of universeParts) {
        for (const failure of universe.failedSymbols) {
            if (!failedSymbols.has(failure.symbol)) {
                failedSymbols.set(failure.symbol, failure.reason);
            }
        }
        for (const entry of universe.engineUsage?.typescriptReasons ?? []) {
            typescriptReasons.set(entry.reason, (typescriptReasons.get(entry.reason) ?? 0) + entry.runs);
        }
    }

    return {
        totalSymbols: Math.max(...universeParts.map((universe) => universe.totalSymbols)),
        loadedSymbols: Math.max(...universeParts.map((universe) => universe.loadedSymbols)),
        candidatePlans: universeParts.reduce((sum, universe) => sum + (universe.candidatePlans ?? 0), 0),
        symbolEvaluations: {
            planned: universeParts.reduce((sum, universe) => sum + (universe.symbolEvaluations?.planned ?? 0), 0),
            completed: universeParts.reduce((sum, universe) => sum + (universe.symbolEvaluations?.completed ?? 0), 0),
            avoided: universeParts.reduce((sum, universe) => sum + (universe.symbolEvaluations?.avoided ?? 0), 0),
            passingCandidates: universeParts.reduce((sum, universe) => sum + (universe.symbolEvaluations?.passingCandidates ?? 0), 0),
        },
        engineUsage: {
            rustRequested: universeParts.some((universe) => universe.engineUsage?.rustRequested === true),
            rustCompletedRuns: universeParts.reduce((sum, universe) => sum + (universe.engineUsage?.rustCompletedRuns ?? 0), 0),
            typescriptCompletedRuns: universeParts.reduce((sum, universe) => sum + (universe.engineUsage?.typescriptCompletedRuns ?? 0), 0),
            typescriptReasons: [...typescriptReasons.entries()]
                .map(([reason, runs]) => ({ reason, runs }))
                .sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason)),
        },
        failedSymbols: [...failedSymbols.entries()]
            .map(([symbol, reason]) => ({ symbol, reason }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol)),
        dataWindow: universeParts
            .slice()
            .reverse()
            .find((universe) => universe.dataWindow)?.dataWindow,
    };
}

/**
 * Sum per-key timings across all parts into one combined timings block,
 * overriding the `total` with the wall-clock elapsed time of the whole job.
 */
function combineUniverseTimings(
    parts: readonly FinderDiagnostics[],
    elapsedMs: number,
): FinderDiagnosticsTimings {
    const timings = createEmptyFinderDiagnosticsTimings();
    for (const part of parts) {
        for (const key of Object.keys(timings) as Array<keyof FinderDiagnosticsTimings>) {
            timings[key] += part.timingsMs[key] ?? 0;
        }
    }
    timings.total = elapsedMs;
    return timings;
}

/**
 * Build the combined job-level diagnostics for a multi-strategy Universe run.
 * Mirrors the prior `FinderManager.buildCombinedUniverseDiagnostics` 1:1 so
 * fixture parity is preserved.
 */
export function buildCombinedUniverseDiagnostics(args: {
    mode: FinderMode;
    interval: string;
    parts: readonly FinderDiagnostics[];
    shownResults: number;
    elapsedMs: number;
}): FinderDiagnostics {
    const { parts, shownResults, elapsedMs, mode, interval } = args;
    const timings = combineUniverseTimings(parts, elapsedMs);

    return buildFinderDiagnostics({
        runId: createFinderRunId("finder-universe"),
        symbol: "SYMBOL_UNIVERSE",
        interval,
        mode,
        engineMode: "symbol_universe",
        inputBars: Math.max(...parts.map((part) => part.data.inputBars)),
        evaluationBars: Math.max(...parts.map((part) => part.data.evaluationBars)),
        selectedStrategies: parts.reduce((sum, part) => sum + part.data.selectedStrategies, 0),
        totalParamRuns: parts.reduce((sum, part) => sum + part.data.totalParamRuns, 0),
        batchSize: Math.max(...parts.map((part) => part.data.batchSize)),
        processedRuns: parts.reduce((sum, part) => sum + part.counts.processedRuns, 0),
        filteredRuns: parts.reduce((sum, part) => sum + part.counts.filteredRuns, 0),
        shownResults,
        endpointAdjusted: parts.reduce((sum, part) => sum + part.counts.endpointAdjusted, 0),
        failedRuns: parts.reduce((sum, part) => sum + part.counts.failedRuns, 0),
        skippedRuns: parts.reduce((sum, part) => sum + part.counts.skippedRuns, 0),
        rustCompletedRuns: parts.reduce((sum, part) => sum + part.counts.rustCompletedRuns, 0),
        rustFallbackRuns: parts.reduce((sum, part) => sum + part.counts.rustFallbackRuns, 0),
        typescriptCompletedRuns: parts.reduce((sum, part) => sum + (part.counts.typescriptCompletedRuns ?? 0), 0),
        timings,
        backtestDiagnostics: combineUniverseBacktestDiagnostics(parts),
        strategyBreakdown: combineUniverseStrategyBreakdown(parts),
        failureBreakdown: combineUniverseFailureBreakdown(parts),
        universeDiagnostics: combineUniverseDiagnosticsBlock(parts),
    });
}

/**
 * Resolve the user-facing sort-priority list from FinderOptions, mirroring
 * the prior `options.universe?.sortPriority ?? []` read in FinderManager.
 */
export function resolveUniverseSortPriority(options: FinderOptions): readonly FinderUniverseMetric[] {
    return options.universe?.sortPriority ?? [];
}
