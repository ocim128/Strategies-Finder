/**
 * Monthly Rank Replay runner — causal monthly evaluation over one frozen
 * candidate pool.
 *
 * Submode of Symbol Universe. At each UTC month boundary T: score the last L
 * closed bars per symbol (earlier closed bars are indicator warmup only),
 * evaluate EVERY canonical candidate over the complete fixed symbol set,
 * select rank #1 independently per historical Universe sort, then forward-
 * test each DISTINCT winner over the next H bars with a fresh flat account.
 *
 * Load-bearing contracts (blueprint FMR audit):
 * - One seeded, normalized candidate pool per run; stable ordinals.
 * - Winners come from the COMPLETE eligible pool — never from a truncated
 *   top-N slice; every symbol must evaluate (valid no-trades included).
 * - Metric availability is rule-specific; missing ≠ zero.
 * - Forward outcomes never change a month's selection; losers stay in the
 *   report; identical winners share one forward evaluation per checkpoint.
 * - Only information closed by T participates in historical ranking.
 * - Account state and statistics are confined to the scored range via the
 *   engine's scoredRange contract; warmup bars feed indicators only.
 *
 * Imports the ordinary universe runner's plan builder and the shared metric
 * layer; no second ranking registry, loader pipeline, or execution engine.
 */

import { executeBacktest, resolveExecutorBacktestSettings } from "../backtest-executor";
import { resolveCapitalSettingsFromRaw } from "../backtest-capital-settings";
import type { CapitalSettings } from "../types/backtest";
import type {
    FinderOptions,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    StrategyParams,
    Time,
} from "../types/strategies";
import type { FinderSelectedStrategy } from "./finder-runner";
import {
    buildUniverseCandidatePlans,
} from "./finder-runner-universe";
import { splitExitStrategyParams } from "./exit-strategy-param-prefix";
import { buildFinderUniverseCandidate, passesFinderUniverseFilters } from "./finder-universe-metrics";
import { computeFinderCompositeEdgeRatio, resolveFinderRiskOverrides } from "./finder-runner-core";
import {
    computeExitAlpha,
} from "./finder-exit-alpha";
import {
    buildFinderPairNeutralMetrics,
    FINDER_PAIR_NEUTRAL_METRIC_BASIS,
    isSyntheticPairFinderSymbol,
    type FinderPairNeutralMetrics,
} from "./finder-pair-neutral";
import { SHARPE_MIN_SAMPLES } from "../strategies/performance-metrics";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    buildMonthlyCheckpointSchedule,
    buildRandomComparison,
    isMonthlyRankReplayMetricAvailable,
    computeReplayRobustUniverseScore,
    buildMonthlyRankReplayIdentityKey,
    computeWindowReturnPercent,
    MonthlyRankReplayWinnerAccumulator,
    resolveBarCloseTimeSec,
    resolveMonthlyRankReplaySortCoverage,
    summarizeMonthlyRankReplaySort,
    validateMonthlyRankReplayOptions,
    type MonthlyRankReplayCheckpointRecord,
    type MonthlyRankReplayForwardOutcome,
    type MonthlyRankReplayOptions,
    type MonthlyRankReplayReport,
    type MonthlyRankReplaySelection,
    type MonthlyRankReplaySortCoverage,
    type MonthlyRankReplaySymbolOutcome,
} from "./finder-monthly-rank-replay";

export interface FinderMonthlyRankReplayRunInput {
    runId: string;
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategies: FinderSelectedStrategy[];
    exitStrategyCandidates?: FinderSelectedStrategy[];
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
}

export interface FinderMonthlyRankReplayRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    /** Streamed after each checkpoint completes (scalar-only records). */
    onCheckpoint?: (
        checkpoint: MonthlyRankReplayCheckpointRecord,
        outcomes: MonthlyRankReplayForwardOutcome[],
        selections: MonthlyRankReplaySelection[],
    ) => void;
}

export interface FinderMonthlyRankReplayRunOutput {
    report: MonthlyRankReplayReport;
    cancelled: boolean;
}

/** Error variant carrying the partial report for the plugin's fatal path. */
interface FinderMonthlyRankReplayFatalError extends Error {
    replayReport?: MonthlyRankReplayReport;
}

interface ReplayCandidate {
    ordinal: number;
    identityKey: string;
    strategyKey: string;
    strategyName: string;
    strategy: import("../types/strategies").Strategy;
    /** Combined entry+exit params as sampled by the plan builder. */
    params: StrategyParams;
    entryParams: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyName?: string;
    exitStrategyParams?: StrategyParams;
    /** Entry settings with sampled risk overrides applied (universe parity). */
    backtestSettings: BacktestSettings;
}

interface ReplaySymbolSeries {
    symbol: string;
    data: OHLCVData[];
    bars: number;
    firstOpenSec: number | null;
    lastCloseSec: number | null;
    synthetic: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertReplayRunSupported(input: FinderMonthlyRankReplayRunInput): {
    replay: MonthlyRankReplayOptions;
    capital: ReturnType<typeof resolveCapitalSettingsFromRaw>;
    universe: NonNullable<FinderOptions["universe"]>;
} {
    const universe = input.options.universe;
    if (!universe) {
        throw new Error("Monthly Rank Replay requires Symbol Universe options.");
    }
    if (input.options.scope !== "symbol_universe") {
        throw new Error("Monthly Rank Replay runs only inside the Symbol Universe scope.");
    }
    if (!input.options.monthlyRankReplay) {
        throw new Error("Monthly Rank Replay options are missing.");
    }
    const replay = validateMonthlyRankReplayOptions(input.options.monthlyRankReplay);
    if (input.options.mode !== "random") {
        throw new Error("Monthly Rank Replay supports Random Search only in v1.");
    }
    if (input.options.polymarketScoringEnabled) {
        throw new Error("Monthly Rank Replay does not support Polymarket scoring in v1.");
    }
    if (universe.symbols.length === 0) {
        throw new Error("Add at least one symbol for Monthly Rank Replay.");
    }
    if (input.selectedStrategies.length === 0) {
        throw new Error("Select at least one strategy for Monthly Rank Replay.");
    }
    for (const selected of [...input.selectedStrategies, ...(input.exitStrategyCandidates ?? [])]) {
        if (selected.strategy.crossSymbolConfig) {
            throw new Error(
                `Monthly Rank Replay cannot guarantee causal auxiliary data for cross-symbol strategy "${selected.name}"; unsupported in v1.`,
            );
        }
        if (selected.strategy.polymarket1sConfig) {
            throw new Error("Monthly Rank Replay does not support 1s Polymarket context strategies in v1.");
        }
    }
    if (input.settings.strategyTimeframeEnabled) {
        throw new Error("Monthly Rank Replay does not support strategy timeframe resampling in v1.");
    }
    if (input.settings.tradeDirection === "combined") {
        throw new Error("Monthly Rank Replay does not support combined direction execution in v1.");
    }
    const capital = resolveCapitalSettingsFromRaw(
        input.capitalSettings as unknown as Record<string, unknown>,
    );
    if (capital.sizingMode !== "fixed") {
        throw new Error(
            `Monthly Rank Replay requires fixed-dollar sizing (requested "${capital.sizingMode}"). Switch the sizing mode to fixed.`,
        );
    }
    if (!(capital.initialCapital > 0) || !(capital.fixedTradeAmount > 0)) {
        throw new Error("Monthly Rank Replay requires positive initial capital and fixed trade amount.");
    }
    return { replay, capital, universe };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function toUnixSecOrNull(time: Time | undefined): number | null {
    if (time === undefined) return null;
    return parseTimeToUnixSeconds(time);
}

function isoLabel(timeSec: number): string {
    return new Date(timeSec * 1000).toISOString();
}

/**
 * Drop trailing bars that have not closed by `nowSec` (open current candle).
 * Historical checkpoint boundaries are defined by the schedule, never by the
 * clock — this only enforces the fully-closed-candle input assumption.
 */
function trimToClosedBars(data: OHLCVData[], interval: string, nowSec: number): OHLCVData[] {
    let end = data.length;
    while (end > 0) {
        const openSec = toUnixSecOrNull(data[end - 1]!.time);
        const closeSec = openSec === null ? null : resolveBarCloseTimeSec(openSec, interval);
        if (closeSec === null || closeSec <= nowSec) break;
        end -= 1;
    }
    return end === data.length ? data : data.slice(0, end);
}

// ---------------------------------------------------------------------------
// Symbol result reduction (mirrors the ordinary universe symbol reduction)
// ---------------------------------------------------------------------------

interface ReplaySymbolEvaluation {
    symbol: string;
    status: FinderUniverseSymbolResult["status"];
    barCount: number;
    result?: NonNullable<FinderUniverseSymbolResult["result"]>;
    error?: string;
    scoredWarmupBars: number;
    scoredStartSec: number | null;
    scoredEndSec: number | null;
}

function buildReplaySymbolEvaluation(args: {
    symbol: string;
    viewBarCount: number;
    scoredWarmupBars: number;
    scoredStartSec: number | null;
    scoredEndSec: number | null;
    result: BacktestResult;
    pairNeutralMetrics: FinderPairNeutralMetrics | null;
    compositeEdgeRatio?: number;
    exitAlpha?: number;
    includeSharpe: boolean;
}): ReplaySymbolEvaluation {
    const metricResult = args.pairNeutralMetrics
        ? { ...args.result, ...args.pairNeutralMetrics }
        : args.result;
    let status: FinderUniverseSymbolResult["status"];
    if (metricResult.totalTrades <= 0) {
        status = "no_trades";
    } else if (metricResult.netProfit > 0.0001) {
        status = "profitable";
    } else if (metricResult.netProfit < -0.0001) {
        status = "losing";
    } else {
        status = "flat";
    }
    return {
        symbol: args.symbol,
        status,
        barCount: args.viewBarCount,
        scoredWarmupBars: args.scoredWarmupBars,
        scoredStartSec: args.scoredStartSec,
        scoredEndSec: args.scoredEndSec,
        result: {
            netProfit: metricResult.netProfit,
            netProfitPercent: metricResult.netProfitPercent,
            expectancy: metricResult.expectancy,
            avgTrade: metricResult.avgTrade,
            winRate: metricResult.winRate,
            profitFactor: metricResult.profitFactor,
            totalTrades: metricResult.totalTrades,
            maxDrawdownPercent: metricResult.maxDrawdownPercent,
            winningTrades: metricResult.winningTrades,
            losingTrades: metricResult.losingTrades,
            avgWin: metricResult.avgWin,
            avgLoss: metricResult.avgLoss,
            sharpeRatio: metricResult.sharpeRatio,
            // Pair-neutral Sharpe below the metric's minimum sample count is
            // a sentinel, not an observation (mirrors the universe runner).
            sharpeRatioAvailable: args.includeSharpe
                && (!args.pairNeutralMetrics || args.pairNeutralMetrics.totalTrades >= SHARPE_MIN_SAMPLES),
            drawdownAvailable: true,
            metricBasis: args.pairNeutralMetrics ? FINDER_PAIR_NEUTRAL_METRIC_BASIS : undefined,
            ...(typeof args.compositeEdgeRatio === "number" && Number.isFinite(args.compositeEdgeRatio)
                ? { compositeEdgeRatio: args.compositeEdgeRatio }
                : {}),
            ...(typeof args.exitAlpha === "number" && Number.isFinite(args.exitAlpha)
                ? { exitAlpha: args.exitAlpha }
                : {}),
        },
    };
}

function toUniverseSymbolResult(evaluation: ReplaySymbolEvaluation): FinderUniverseSymbolResult {
    return {
        symbol: evaluation.symbol,
        status: evaluation.status,
        barCount: evaluation.barCount,
        result: evaluation.result,
        ...(evaluation.error ? { error: evaluation.error } : {}),
    };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runFinderMonthlyRankReplay(
    input: FinderMonthlyRankReplayRunInput,
    callbacks: FinderMonthlyRankReplayRunCallbacks,
): Promise<FinderMonthlyRankReplayRunOutput> {
    const { replay, capital, universe } = assertReplayRunSupported(input);
    const { replayed, excluded } = resolveMonthlyRankReplaySortCoverage();
    const nowSec = Math.floor(Date.now() / 1000);

    // ------------------------------------------------------------------
    // Load once per symbol; the fixed symbol set shares every checkpoint.
    // ------------------------------------------------------------------
    callbacks.setProgress(0, "Monthly Rank Replay: loading universe symbols...");
    const symbols: string[] = [];
    {
        const seen = new Set<string>();
        for (const raw of universe.symbols) {
            const normalized = raw.trim().toUpperCase();
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                symbols.push(normalized);
            }
        }
    }

    const seriesBySymbol = new Map<string, ReplaySymbolSeries>();
    const symbolLoadErrors = new Map<string, string>();
    for (let i = 0; i < symbols.length; i += 1) {
        const symbol = symbols[i]!;
        if (callbacks.isCancelled()) {
            return { report: buildCancelledReport(input, replay, symbols, replayed, excluded, capital), cancelled: true };
        }
        callbacks.setProgress(
            ((i + 1) / Math.max(1, symbols.length)) * 10,
            `Monthly Rank Replay: loading ${symbol} (${i + 1}/${symbols.length})...`,
        );
        try {
            const data = await input.loadDataset(symbol, input.interval);
            const closed = (!Array.isArray(data) || data.length === 0)
                ? []
                : trimToClosedBars(data, input.interval, nowSec);
            if (closed.length === 0) {
                symbolLoadErrors.set(symbol, "No closed candles returned.");
                continue;
            }
            seriesBySymbol.set(symbol, {
                symbol,
                data: closed,
                bars: closed.length,
                firstOpenSec: toUnixSecOrNull(closed[0]!.time),
                lastCloseSec: toUnixSecOrNull(closed[closed.length - 1]!.time) === null
                    ? null
                    : resolveBarCloseTimeSec(
                        toUnixSecOrNull(closed[closed.length - 1]!.time)!,
                        input.interval,
                    ),
                synthetic: isSyntheticPairFinderSymbol(symbol),
            });
        } catch (error) {
            symbolLoadErrors.set(
                symbol,
                error instanceof Error ? error.message : String(error),
            );
        }
        await callbacks.yieldControl();
    }

    // Symbols that failed to load are excluded from EVERY checkpoint (with
    // the load error as the recorded reason) instead of blocking the whole
    // run. The warn line and Copy Results name them; only a run where
    // nothing loaded returns the coverage report without a search.
    const loadFailedExclusions = new Map<string, string>(
        [...symbolLoadErrors.entries()].map(([symbol, error]) => [symbol, `load failed: ${error}`]),
    );
    if (seriesBySymbol.size === 0) {
        return {
            cancelled: false,
            report: buildCoverageOnlyReport(input, replay, symbols, replayed, excluded, capital, seriesBySymbol, symbolLoadErrors),
        };
    }

    // ------------------------------------------------------------------
    // Frozen candidate pool: one seeded plan generation across all
    // selected strategies, deduplicated by canonical identity.
    // ------------------------------------------------------------------
    const pool: ReplayCandidate[] = [];
    {
        const seenIdentities = new Set<string>();
        let ordinal = 0;
        for (const selectedStrategy of input.selectedStrategies) {
            const plans = buildUniverseCandidatePlans({
                selectedStrategy,
                exitStrategyCandidates: input.options.exitStrategyOverrideEnabled
                    ? (input.exitStrategyCandidates ?? [])
                    : [],
                settings: input.settings,
                options: input.options,
                generateParamSets: input.generateParamSets,
            });
            for (const plan of plans) {
                const splitParams = plan.exitStrategyKey
                    ? splitExitStrategyParams(plan.params)
                    : null;
                const entryParams = splitParams ? splitParams.entryParams : plan.params;
                const identityKey = buildMonthlyRankReplayIdentityKey({
                    strategyKey: selectedStrategy.key,
                    strategyName: selectedStrategy.name,
                    params: entryParams,
                    exitStrategyKey: plan.exitStrategyKey,
                    exitStrategyParams: plan.exitStrategyParams,
                });
                if (seenIdentities.has(identityKey)) continue;
                seenIdentities.add(identityKey);
                // Mirror the ordinary universe loop: sampled risk params
                // (ATR period, stop/tp, max-hold) resolve into per-candidate
                // settings, not into strategy execution params. The second
                // argument is the Rust-mirror settings, which replay discards
                // (engineMode "typescript" everywhere); backtestSettings here
                // derives from input.settings exactly as the ordinary loop's
                // does.
                const { backtestSettings: riskAdjustedSettings } = resolveFinderRiskOverrides(
                    input.settings,
                    input.settings,
                    plan.params,
                    input.options,
                );
                pool.push({
                    ordinal: ordinal++,
                    identityKey,
                    strategyKey: selectedStrategy.key,
                    strategyName: selectedStrategy.name,
                    strategy: selectedStrategy.strategy,
                    params: plan.params,
                    entryParams,
                    backtestSettings: riskAdjustedSettings,
                    exitStrategyKey: plan.exitStrategyKey,
                    exitStrategyName: plan.exitStrategyName,
                    exitStrategyParams: plan.exitStrategyParams,
                });
            }
        }
    }

    if (pool.length === 0) {
        const report = buildCoverageOnlyReport(
            input, replay, symbols, replayed, excluded, capital, seriesBySymbol, symbolLoadErrors,
        );
        // Surface the reason as a checkpoint record: the coverage-only report
        // has no scheduled checkpoints, so the reason must travel on a
        // synthetic January record to be visible in the UI and in Copy.
        report.checkpoints.push({
            index: 0,
            label: replay.fromYear + "-01",
            timeSec: Date.UTC(replay.fromYear, 0, 1) / 1000,
            status: "unavailable",
            distinctWinners: 0,
            reason:
                "No candidate configurations were generated. Check Runs/Strategy, Range %, and Steps/Param for the selected strategies.",
        });
        for (const summary of report.sortSummaries) {
            summary.excludedCounts.unshift({ reason: "no candidate configurations", count: 1 });
        }
        return { cancelled: false, report };
    }

    // ------------------------------------------------------------------
    // Checkpoint schedule + per-symbol feasibility.
    // ------------------------------------------------------------------
    // The schedule spans the run's OVERALL data extent (the latest closed
    // bar across loaded series); per-checkpoint membership trims symbols
    // whose own data ends earlier, instead of truncating the schedule for
    // every symbol.
    const lastClosedTimeSec = Math.max(
        ...[...seriesBySymbol.values()].map((series) => series.lastCloseSec ?? Number.NEGATIVE_INFINITY),
    );
    const schedule = buildMonthlyCheckpointSchedule(replay.fromYear, lastClosedTimeSec);
    const intervalClose = (series: ReplaySymbolSeries, index: number): number | null => {
        const openSec = toUnixSecOrNull(series.data[index]!.time);
        return openSec === null ? null : resolveBarCloseTimeSec(openSec, input.interval);
    };
    // For each scheduled checkpoint, the per-symbol historical end index
    // (last bar closed at or before the boundary).
    // Point-in-time membership from CHECKPOINT-TIME information only: a
    // symbol needs sufficient closed scored history to enter the historical
    // ranking. Forward-horizon availability is NOT a membership condition —
    // missing future bars must not remove symbols and thereby change the
    // historical winner; such symbols are retained and their missing forward
    // outcomes invalidate measurements downstream (never shrink pools).
    const resolveCheckpointMembership = (checkpointSec: number): {
        histEndBySymbol: Map<string, number>;
        excluded: Array<{ symbol: string; reason: string }>;
    } => {
        const histEndBySymbol = new Map<string, number>();
        const excluded: Array<{ symbol: string; reason: string }> = [];
        // Iterate the CANONICAL symbol list: load-failed symbols are absent
        // from seriesBySymbol and must still be recorded as exclusions.
        for (const symbol of symbols) {
            const loadFailure = loadFailedExclusions.get(symbol);
            const series = seriesBySymbol.get(symbol);
            if (loadFailure || !series) {
                excluded.push({ symbol, reason: loadFailure ?? "load failed: no data" });
                continue;
            }
            let histEnd = -1;
            for (let i = series.data.length - 1; i >= 0; i -= 1) {
                const closeSec = intervalClose(series, i);
                if (closeSec !== null && closeSec <= checkpointSec) {
                    histEnd = i;
                    break;
                }
            }
            if (histEnd < replay.evalWindowBars - 1) {
                excluded.push({ symbol, reason: "insufficient closed history for the eval window" });
                continue;
            }
            histEndBySymbol.set(symbol, histEnd);
        }
        return { histEndBySymbol, excluded };
    };

    // Per-symbol coverage rows (warmup at the first scheduled checkpoint, or
    // at the last one when nothing is scheduled yet).
    const symbolCoverage = symbols.map((symbol) => {
        const series = seriesBySymbol.get(symbol);
        const referenceCheckpoint = schedule.length > 0 ? schedule[0]!.timeSec : lastClosedTimeSec;
        let warmupBars = 0;
        if (series) {
            for (let i = series.data.length - 1; i >= 0; i -= 1) {
                const closeSec = intervalClose(series, i);
                if (closeSec !== null && closeSec <= referenceCheckpoint) {
                    warmupBars = Math.max(0, i + 1 - replay.evalWindowBars);
                    break;
                }
            }
        }
        return {
            symbol,
            bars: series?.bars ?? 0,
            firstOpenLabel: series?.firstOpenSec != null ? isoLabel(series.firstOpenSec) : undefined,
            lastCloseLabel: series?.lastCloseSec != null ? isoLabel(series.lastCloseSec) : undefined,
            warmupBarsAtFirstCheckpoint: warmupBars,
            synthetic: series?.synthetic ?? isSyntheticPairFinderSymbol(symbol),
            ...(symbolLoadErrors.get(symbol) ? { error: symbolLoadErrors.get(symbol)! } : {}),
        };
    });

    const experiment = {
        fromYear: replay.fromYear,
        evalWindowBars: replay.evalWindowBars,
        forwardBars: replay.forwardBars,
        interval: input.interval,
        symbols,
        strategyKeys: input.selectedStrategies.map((strategy) => strategy.key),
        replayedSorts: replayed.map((sort) => ({ key: sort.key, label: sort.label, direction: sort.direction })),
        excludedSorts: excluded,
        engine: "typescript" as const,
        sizingMode: "fixed" as const,
        capitalSettings: capital as unknown as Record<string, unknown>,
        candidatePool: {
            requestedRunsPerStrategy: Math.max(1, Math.floor(input.options.maxRuns || 0)),
            actualCandidates: pool.length,
            seed: typeof input.options.randomSeed === "number" ? input.options.randomSeed : null,
        },
        conventions: {
            checkpoint: "UTC month boundary; a bar is closed when barOpenTime + intervalDuration <= checkpoint",
            historicalWindow: "last L closed bars per symbol; earlier closed bars are indicator warmup only",
            forwardWindow:
                "H bars starting with the first bar after the checkpoint's last closed bar; on intervals not aligned to the boundary that first bar may open before the boundary (its close and all fills still occur at/after it); fresh flat account",
            signalPolicy:
                "signal must originate in the scored region AND resolve inside it; terminal liquidation at the final scored close with commission + direction-correct slippage",
            accounting:
                "equal-weight mean of the checkpoint's retained symbols; symbols lacking sufficient scored/forward bars at that checkpoint are excluded and listed on its record; pair-neutral transform for synthetic pairs",
                baseline:
                    "per sort: randomExpectedReturn = equal-weight mean of that sort's eligible configurations' forward returns at the same checkpoint (winner included, each unique configuration once); excess = top-1 − random mean",
        },
    };

    // ------------------------------------------------------------------
    // No feasible checkpoints: return the coverage report without search.
    // ------------------------------------------------------------------
    if (schedule.length === 0) {
        const report = buildCoverageOnlyReport(
            input, replay, symbols, replayed, excluded, capital, seriesBySymbol, symbolLoadErrors,
        );
        report.symbolCoverage.length = 0;
        report.symbolCoverage.push(...symbolCoverage);
        (report as { experiment?: unknown }).experiment = experiment;
        report.checkpoints.push({
            index: 0,
            label: replay.fromYear + "-01",
            timeSec: Date.UTC(replay.fromYear, 0, 1) / 1000,
            status: "unavailable",
            distinctWinners: 0,
            reason: "January of the From year is after the latest closed candle; no checkpoint is schedulable.",
        });
        return { cancelled: false, report };
    }

    // ------------------------------------------------------------------
    // Monthly loop.
    // ------------------------------------------------------------------
    const report: MonthlyRankReplayReport = {
        kind: "monthly_rank_replay",
        runId: input.runId,
        experiment,
        checkpoints: [],
        symbolCoverage,
        forwardOutcomes: [],
        selections: [],
        sortSummaries: [],
    };
    const preResolvedCapital = capital;
    let completedCheckpoints = 0;
    let cancelled = false;

    // Any error escaping the monthly loop must carry the partial report
    // (fatal-flagged) so the job-level failure retains partial results on
    // /status instead of discarding completed checkpoints.
    try {
    for (let checkpointIndex = 0; checkpointIndex < schedule.length; checkpointIndex += 1) {
        if (callbacks.isCancelled()) {
            cancelled = true;
            break;
        }
        const checkpoint = schedule[checkpointIndex]!;
        const { histEndBySymbol, excluded: excludedSymbols } = resolveCheckpointMembership(checkpoint.timeSec);

        const checkpointRecord: MonthlyRankReplayCheckpointRecord = {
            index: checkpoint.index,
            label: checkpoint.label,
            timeSec: checkpoint.timeSec,
            status: "measured",
            distinctWinners: 0,
            retainedSymbols: histEndBySymbol.size,
            ...(excludedSymbols.length > 0 ? { excludedSymbols } : {}),
        };

        if (histEndBySymbol.size === 0) {
            checkpointRecord.status = "unavailable";
            const reason = excludedSymbols
                .slice(0, 8)
                .map((entry) => `${entry.symbol}: ${entry.reason}`)
                .join("; ")
                + (excludedSymbols.length > 8 ? `; +${excludedSymbols.length - 8} more` : "");
            checkpointRecord.reason = `Checkpoint unavailable (${excludedSymbols.length}/${symbols.length} symbols): ${reason}`;
            report.checkpoints.push(checkpointRecord);
            appendUnselectedSorts(report, replayed, checkpoint, "checkpoint unavailable");
            callbacks.onCheckpoint?.(checkpointRecord, [], report.selections.filter(
                (selection) => selection.checkpointIndex === checkpoint.index,
            ));
            callbacks.setProgress(
                10 + ((checkpointIndex + 1) / schedule.length) * 90,
                `Monthly Rank Replay: ${checkpoint.label} unavailable (no symbol has sufficient coverage)`,
            );
            await callbacks.yieldControl();
            continue;
        }

        // Causal views for this checkpoint. Historical: prefix ending at the
        // scored end bar. Forward: prefix ending H bars later. Immutable
        // copies of the reference arrays — no view mutates another.
        const histViews = new Map<string, OHLCVData[]>();
        const forwardViews = new Map<string, OHLCVData[]>();
        for (const [symbol, histEnd] of histEndBySymbol) {
            const series = seriesBySymbol.get(symbol)!;
            histViews.set(symbol, series.data.slice(0, histEnd + 1));
            forwardViews.set(symbol, series.data.slice(0, histEnd + replay.forwardBars + 1));
        }

        // ------------------ historical evaluation ------------------
        const accumulator = new MonthlyRankReplayWinnerAccumulator(replayed.map((sort) => sort.key));
        const sortCoverageByKey = new Map(replayed.map((sort) => [sort.key, sort]));
        // Baseline pools: every historically eligible configuration PER SORT
        // (completeness gate + filters + this sort's metric availability).
        // Sorts may legitimately have different pools.
        const eligibleBySort = new Map<string, string[]>();
        let completeCandidates = 0;
        let incompleteCandidates = 0;
        let candidateExecutionFailures = 0;

        for (let candidateIndex = 0; candidateIndex < pool.length; candidateIndex += 1) {
            if (callbacks.isCancelled()) {
                cancelled = true;
                break;
            }
            const candidate = pool[candidateIndex]!;
            const evaluations = new Map<string, ReplaySymbolEvaluation>();
            let candidateFailed = false;
            let candidateIncomplete = false;

            for (const [symbol, histEnd] of histEndBySymbol) {
                const series = seriesBySymbol.get(symbol)!;
                const view = histViews.get(symbol)!;
                const scoredStart = histEnd + 1 - replay.evalWindowBars;
                const scoredRange = {
                    startBarTime: view[scoredStart]!.time,
                    endBarTime: view[histEnd]!.time,
                };
                const warmupBars = scoredStart;

                let output;
                try {
                    output = await executeReplayBacktest({
                        input,
                        strategyKey: candidate.strategyKey,
                        strategy: candidate.strategy,
                        entryParams: candidate.entryParams,
                        candidateSettings: candidate.backtestSettings,
                        exitStrategyKey: candidate.exitStrategyKey,
                        exitStrategyParams: candidate.exitStrategyParams,
                        data: view,
                        interval: input.interval,
                        scoredRange,
                        capital: preResolvedCapital,
                        requireTradeHistory: true,
                    });
                } catch (error) {
                    candidateFailed = true;
                    candidateExecutionFailures += 1;
                    evaluations.set(symbol, {
                        symbol,
                        status: "run_failed",
                        barCount: view.length,
                        scoredWarmupBars: warmupBars,
                        scoredStartSec: toUnixSecOrNull(scoredRange.startBarTime),
                        scoredEndSec: toUnixSecOrNull(scoredRange.endBarTime),
                        error: error instanceof Error ? error.message : String(error),
                    });
                    continue;
                }

                const pairNeutralMetrics = series.synthetic
                    ? buildFinderPairNeutralMetrics(output.result, preResolvedCapital)
                    : null;
                if (series.synthetic && output.result.totalTrades > 0 && pairNeutralMetrics === null) {
                    // A traded result that cannot be transformed is invalid.
                    candidateIncomplete = true;
                    evaluations.set(symbol, {
                        symbol,
                        status: "run_failed",
                        barCount: view.length,
                        scoredWarmupBars: warmupBars,
                        scoredStartSec: toUnixSecOrNull(scoredRange.startBarTime),
                        scoredEndSec: toUnixSecOrNull(scoredRange.endBarTime),
                        error: "pair-neutral transformation failed for a traded result",
                    });
                    continue;
                }

                let exitAlpha: number | undefined;
                if (sortCoverageByKey.has("medianExitAlpha")) {
                    try {
                        const controlOutput = await executeReplayBacktest({
                            input,
                            strategyKey: candidate.strategyKey,
                            strategy: candidate.strategy,
                            entryParams: candidate.entryParams,
                            candidateSettings: candidate.backtestSettings,
                            exitStrategyKey: candidate.exitStrategyKey,
                            exitStrategyParams: candidate.exitStrategyParams,
                            data: view,
                            interval: input.interval,
                            scoredRange,
                            capital: preResolvedCapital,
                            requireTradeHistory: true,
                            forceDisableSignalExits: true,
                            preGeneratedSignals: output.signals,
                        });
                        const controlPairNeutral = series.synthetic
                            ? buildFinderPairNeutralMetrics(controlOutput.result, preResolvedCapital)
                            : null;
                        exitAlpha = series.synthetic
                            ? (pairNeutralMetrics && controlPairNeutral
                                ? computeExitAlpha(pairNeutralMetrics, controlPairNeutral)
                                : undefined)
                            : computeExitAlpha(output.result, controlOutput.result);
                    } catch {
                        // A failed counterfactual is missing, not zero.
                    }
                }

                const edgeRatio = sortCoverageByKey.has("medianCompositeEdgeRatio")
                    ? computeFinderCompositeEdgeRatio(output.result, view)
                    : undefined;

                evaluations.set(symbol, buildReplaySymbolEvaluation({
                    symbol,
                    viewBarCount: view.length,
                    scoredWarmupBars: warmupBars,
                    scoredStartSec: toUnixSecOrNull(scoredRange.startBarTime),
                    scoredEndSec: toUnixSecOrNull(scoredRange.endBarTime),
                    result: output.result,
                    pairNeutralMetrics,
                    compositeEdgeRatio: edgeRatio,
                    exitAlpha,
                    includeSharpe: true,
                }));
                // Release per-symbol trade/equity arrays; only the scalar
                // evaluation rows survive this loop.
                output.result.trades = [];
                output.result.equityCurve = [];
            }

            if (cancelled) break;

            // Completeness gate: EVERY symbol must have evaluated
            // successfully (valid no-trades included).
            const complete = !candidateFailed
                && !candidateIncomplete
                && evaluations.size === histEndBySymbol.size
                && [...evaluations.values()].every((evaluation) => !evaluation.error);
            if (!complete) {
                incompleteCandidates += 1;
                continue;
            }
            completeCandidates += 1;

            const retainedSymbolList = [...histEndBySymbol.keys()];
            const universeCandidate = buildFinderUniverseCandidate({
                strategyKey: candidate.strategyKey,
                strategyName: candidate.strategyName,
                params: candidate.entryParams,
                symbols: retainedSymbolList.map((symbol) => toUniverseSymbolResult(evaluations.get(symbol)!)),
                ...(candidate.exitStrategyKey
                    ? {
                        exitStrategyKey: candidate.exitStrategyKey,
                        exitStrategyName: candidate.exitStrategyName,
                        exitStrategyParams: candidate.exitStrategyParams,
                    }
                    : {}),
            });

            // Replay robust-row contract: recompute the robust score with its
            // ordinary single-sort dependency (PF fallback) so computing CER
            // for the edge sort cannot change this row's ranking formula.
            universeCandidate.robustUniverseScore = computeReplayRobustUniverseScore(universeCandidate);

            // Applicable historical eligibility filters, after the
            // completeness gate.
            if (!passesFinderUniverseFilters(universeCandidate, universe)) continue;

            accumulator.offer(universeCandidate, candidate.identityKey, candidate.ordinal);
            for (const sort of replayed) {
                if (!isMonthlyRankReplayMetricAvailable(universeCandidate, sort.key)) continue;
                let eligibleList = eligibleBySort.get(sort.key);
                if (!eligibleList) {
                    eligibleList = [];
                    eligibleBySort.set(sort.key, eligibleList);
                }
                eligibleList.push(candidate.identityKey);
            }
            if ((candidateIndex + 1) % 8 === 0) {
                callbacks.setProgress(
                    10 + ((checkpointIndex + (candidateIndex + 1) / pool.length) / schedule.length) * 80,
                    `Monthly Rank Replay: ${checkpoint.label} — candidate ${candidateIndex + 1}/${pool.length}`,
                );
                await callbacks.yieldControl();
            }
        }

        if (cancelled) break;

        // ------------------ forward evaluation ------------------
        const winners = accumulator.winners();
        const poolByIdentity = new Map(pool.map((entry) => [entry.identityKey, entry]));
        const outcomeIndexByIdentity = new Map<string, number>();
        // Distinct winning CONFIGURATIONS (not sort slots): several sorts can
        // select the same candidate, so this is at most the pool size and is
        // the number of forward evaluations shipped for the checkpoint.
        checkpointRecord.distinctWinners = new Set(
            [...winners.values()].map((winner) => winner.identityKey),
        ).size;

        // Random-choice baseline: every sort's eligible pool must be measured
        // over the SAME forward horizon. Union winners with all pool members
        // so each distinct configuration is evaluated exactly once per
        // checkpoint; sorts sharing a configuration share its outcome.
        const winnerIdentities = new Set([...winners.values()].map((winner) => winner.identityKey));
        const neededIdentities = new Set<string>(winnerIdentities);
        for (const eligibleList of eligibleBySort.values()) {
            for (const identityKey of eligibleList) neededIdentities.add(identityKey);
        }

        // Transient scalar reductions for the baseline. Only winner outcomes
        // enter report.forwardOutcomes; nonwinner detail is released here.
        const forwardResults = new Map<string, { measured: boolean; value: number | null }>();
        for (const identityKey of neededIdentities) {
            if (callbacks.isCancelled()) {
                cancelled = true;
                break;
            }
            const poolCandidate = poolByIdentity.get(identityKey);
            if (!poolCandidate) continue;
            const outcome = await evaluateForwardOutcome({
                checkpoint,
                input,
                seriesBySymbol,
                histEndBySymbol,
                forwardViews,
                candidate: {
                    identityKey,
                    strategyKey: poolCandidate.strategyKey,
                    strategyName: poolCandidate.strategyName,
                    strategy: poolCandidate.strategy,
                    entryParams: poolCandidate.entryParams,
                    backtestSettings: poolCandidate.backtestSettings,
                    exitStrategyKey: poolCandidate.exitStrategyKey,
                    exitStrategyName: poolCandidate.exitStrategyName,
                    exitStrategyParams: poolCandidate.exitStrategyParams,
                },
                replay,
                capital: preResolvedCapital,
            });
            const measured = outcome.status === "measured"
                && outcome.windowReturnPercent !== null
                && Number.isFinite(outcome.windowReturnPercent);
            forwardResults.set(identityKey, { measured, value: measured ? outcome.windowReturnPercent! : null });
            if (winnerIdentities.has(identityKey)) {
                report.forwardOutcomes.push(outcome);
                outcomeIndexByIdentity.set(identityKey, report.forwardOutcomes.length - 1);
            }
            // Release per-symbol rows for nonwinner outcomes immediately; the
            // baseline only needs the scalar window return.
            if (!winnerIdentities.has(identityKey)) {
                outcome.symbols.length = 0;
            }
        }

        for (const [sortKey, winner] of winners) {
            if (cancelled) break;
            const sort = sortCoverageByKey.get(sortKey)!;
            const selection: MonthlyRankReplaySelection = {
                checkpointIndex: checkpoint.index,
                checkpointLabel: checkpoint.label,
                sortKey,
                sortLabel: sort.label,
                direction: sort.direction,
                score: winner.score,
                aggregationLabel: sort.label,
                historicalActiveSymbols: winner.candidate.activeSymbols,
                historicalSharpeContributors: winner.candidate.medianSharpeAvailable
                    ? winner.candidate.symbols.filter((symbol) => symbol.result?.sharpeRatioAvailable === true).length
                    : 0,
                status: "measured",
                identityKey: winner.identityKey,
                strategyKey: winner.candidate.strategyKey,
                strategyName: winner.candidate.strategyName,
                params: winner.candidate.params,
                ...(winner.candidate.exitStrategyKey
                    ? {
                        exitStrategyKey: winner.candidate.exitStrategyKey,
                        exitStrategyParams: { ...(winner.candidate.exitStrategyParams ?? {}) },
                    }
                    : {}),
            };

            const outcomeIndex = outcomeIndexByIdentity.get(winner.identityKey);
            if (outcomeIndex !== undefined) {
                const outcome = report.forwardOutcomes[outcomeIndex]!;
                selection.forwardOutcomeIndex = outcomeIndex;
                selection.forwardReturnPercent = outcome.windowReturnPercent;
                if (outcome.status !== "measured") {
                    selection.status = outcome.status === "failed" ? "forward_failed" : "incomplete_horizon";
                    selection.reason = outcome.reason;
                }
            }
            selection.comparison = buildRandomComparison({
                eligibleIdentityKeys: eligibleBySort.get(sortKey) ?? [],
                forwardResults,
                selectedIdentityKey: winner.identityKey,
            });
            report.selections.push(selection);
        }

        // Sorts with no eligible/available candidate at this checkpoint.
        for (const sort of replayed) {
            if (winners.has(sort.key)) continue;
            report.selections.push({
                checkpointIndex: checkpoint.index,
                checkpointLabel: checkpoint.label,
                sortKey: sort.key,
                sortLabel: sort.label,
                direction: sort.direction,
                score: null,
                aggregationLabel: sort.label,
                historicalActiveSymbols: 0,
                historicalSharpeContributors: 0,
                status: "no_selection",
                reason: completeCandidates === 0
                    ? candidateExecutionFailures > 0
                        ? "no eligible candidate: every candidate failed evaluation"
                        : "no eligible candidate: no candidate passed the completeness gate and filters"
                    : "no candidate provided an available value for this sort",
            });
        }

        checkpointRecord.status = "measured";
        report.checkpoints.push(checkpointRecord);
        completedCheckpoints += 1;
        callbacks.onCheckpoint?.(
            checkpointRecord,
            report.forwardOutcomes.filter((outcome) => outcome.checkpointIndex === checkpoint.index),
            report.selections.filter((selection) => selection.checkpointIndex === checkpoint.index),
        );
        callbacks.setProgress(
            10 + ((checkpointIndex + 1) / schedule.length) * 90,
            `Monthly Rank Replay: ${checkpoint.label} done (${winners.size} distinct winners)`,
        );
        await callbacks.yieldControl();

        // Release this month's views.
        histViews.clear();
        forwardViews.clear();
    }
    } catch (error) {
        const fatal = error as FinderMonthlyRankReplayFatalError;
        report.sortSummaries = buildSortSummaries(report, replayed, schedule.length);
        report.fatal = fatal instanceof Error ? fatal.message : String(fatal);
        report.stoppedEarly = { reason: "fatal", completedCheckpoints };
        fatal.replayReport = report;
        throw fatal;
    }

    if (cancelled) {
        report.stoppedEarly = { reason: "cancelled", completedCheckpoints };
    }

    // ------------------ summaries ------------------
    report.sortSummaries = buildSortSummaries(report, replayed, schedule.length);
    callbacks.setProgress(100, `Monthly Rank Replay complete (${completedCheckpoints}/${schedule.length} checkpoints measured)`);
    return { report, cancelled };
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

async function executeReplayBacktest(args: {
    input: FinderMonthlyRankReplayRunInput;
    strategyKey: string;
    strategy: import("../types/strategies").Strategy;
    entryParams: StrategyParams;
    candidateSettings: BacktestSettings;
    exitStrategyKey?: string;
    exitStrategyParams?: StrategyParams;
    data: OHLCVData[];
    interval: string;
    scoredRange: { startBarTime: Time; endBarTime: Time };
    capital: ReturnType<typeof resolveCapitalSettingsFromRaw>;
    requireTradeHistory: boolean;
    forceDisableSignalExits?: boolean;
    preGeneratedSignals?: import("../types/strategies").Signal[];
}) {
    const { input } = args;
    const backtestSettings: BacktestSettings = args.exitStrategyKey
        ? {
            ...args.candidateSettings,
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: args.exitStrategyKey,
            exitStrategyParams: { ...(args.exitStrategyParams ?? {}) },
        }
        : args.candidateSettings;
    const preResolvedSettings = resolveExecutorBacktestSettings(
        { ...(backtestSettings as Record<string, unknown>), interval: args.interval } as BacktestSettings,
        args.interval,
    );
    return executeBacktest({
        ohlcvData: args.data,
        // The causal view is pre-sliced; skip closed-candle trimming so the
        // checkpoint boundary (not the current clock) defines the timeline.
        closedCandleDataOverride: args.data,
        interval: args.interval,
        primarySymbol: "",
        strategyKey: args.strategyKey,
        strategy: args.strategy,
        strategyParams: args.entryParams,
        backtestSettings,
        capitalSettings: input.capitalSettings,
        preResolvedSettings,
        preResolvedCapital: args.capital,
        ...(args.preGeneratedSignals ? { preGeneratedSignals: args.preGeneratedSignals } : {}),
        context: {
            blockRange: null,
            annotatePolymarket: false,
            // Replay is TypeScript-only in v1.
            engineMode: "typescript",
            nowSec: Math.floor(Date.now() / 1000),
        },
        backtestRunOptions: {
            scoredRange: args.scoredRange,
            useCompactBacktest: false,
            includeAdvancedAnalytics: false,
            includeSharpeRatio: true,
            skipDrawdown: false,
            omitEquityCurve: false,
            skipResultPostProcessing: true,
            requireTradeHistory: args.requireTradeHistory,
            ...(args.forceDisableSignalExits ? { forceDisableSignalExits: true } : {}),
        },
    });
}

async function evaluateForwardOutcome(args: {
    checkpoint: { index: number; label: string; timeSec: number };
    input: FinderMonthlyRankReplayRunInput;
    seriesBySymbol: Map<string, ReplaySymbolSeries>;
    histEndBySymbol: Map<string, number>;
    forwardViews: Map<string, OHLCVData[]>;
    candidate: {
        identityKey: string;
        strategyKey: string;
        strategyName: string;
        strategy: import("../types/strategies").Strategy;
        entryParams: StrategyParams;
        backtestSettings: BacktestSettings;
        exitStrategyKey?: string;
        exitStrategyName?: string;
        exitStrategyParams?: StrategyParams;
    };
    replay: MonthlyRankReplayOptions;
    capital: ReturnType<typeof resolveCapitalSettingsFromRaw>;
}): Promise<MonthlyRankReplayForwardOutcome> {
    const { input, replay } = args;
    const symbolOutcomes: MonthlyRankReplaySymbolOutcome[] = [];
    let failed = false;
    let failureReason: string | undefined;

    for (const [symbol, histEnd] of args.histEndBySymbol) {
        const series = args.seriesBySymbol.get(symbol)!;
        const view = args.forwardViews.get(symbol)!;
        const forwardStart = histEnd + 1;
        const forwardEnd = histEnd + replay.forwardBars;
        if (forwardEnd >= view.length) {
            // Membership is historical-only: this symbol ranked, but the
            // loaded data lacks its forward horizon. Record a MISSING
            // outcome (never zero); the window/comparison is invalidated
            // downstream without shrinking any pool. The data may even end
            // exactly at the checkpoint (no forward bar exists at all), so
            // the scored-start label is optional here.
            const reason = "incomplete forward horizon in loaded data";
            failureReason = failureReason ?? `${symbol}: ${reason}`;
            const scoredStartLabel = forwardStart < view.length
                ? isoLabel(toUnixSecOrNull(view[forwardStart]!.time)!)
                : undefined;
            symbolOutcomes.push({
                symbol,
                measurementBasis: series.synthetic ? "pair_neutral_log" : "cash",
                returnPercent: Number.NaN,
                totalTrades: 0,
                ...(scoredStartLabel ? { scoredStartLabel } : {}),
                warmupBars: forwardStart,
                error: reason,
            });
            continue;
        }
        const scoredRange = {
            startBarTime: view[forwardStart]!.time,
            endBarTime: view[forwardEnd]!.time,
        };
        try {
            const output = await executeReplayBacktest({
                input,
                strategyKey: args.candidate.strategyKey,
                strategy: args.candidate.strategy,
                entryParams: args.candidate.entryParams,
                candidateSettings: args.candidate.backtestSettings,
                exitStrategyKey: args.candidate.exitStrategyKey,
                exitStrategyParams: args.candidate.exitStrategyParams,
                data: view,
                interval: input.interval,
                scoredRange,
                capital: args.capital,
                requireTradeHistory: true,
            });
            const totalTrades = output.result.totalTrades;
            let returnPercent: number;
            let basis: MonthlyRankReplaySymbolOutcome["measurementBasis"];
            if (totalTrades <= 0) {
                // Successfully evaluated no-trade: explicitly zero.
                returnPercent = 0;
                basis = "no_trades";
            } else if (series.synthetic) {
                const neutral = buildFinderPairNeutralMetrics(output.result, args.capital);
                if (neutral === null) {
                    failed = true;
                    failureReason = `${symbol}: pair-neutral transformation failed for a traded result`;
                    symbolOutcomes.push({
                        symbol,
                        measurementBasis: "pair_neutral_log",
                        returnPercent: Number.NaN,
                        totalTrades,
                        scoredStartLabel: isoLabel(toUnixSecOrNull(scoredRange.startBarTime)!),
                        scoredEndLabel: isoLabel(toUnixSecOrNull(scoredRange.endBarTime)!),
                        warmupBars: forwardStart,
                        error: failureReason,
                    });
                    output.result.trades = [];
                    output.result.equityCurve = [];
                    continue;
                }
                returnPercent = neutral.netProfitPercent;
                basis = "pair_neutral_log";
            } else {
                returnPercent = output.result.netProfitPercent;
                basis = "cash";
            }
            symbolOutcomes.push({
                symbol,
                measurementBasis: basis,
                returnPercent,
                totalTrades,
                scoredStartLabel: isoLabel(toUnixSecOrNull(scoredRange.startBarTime)!),
                scoredEndLabel: isoLabel(toUnixSecOrNull(scoredRange.endBarTime)!),
                warmupBars: forwardStart,
            });
            output.result.trades = [];
            output.result.equityCurve = [];
        } catch (error) {
            failed = true;
            const message = error instanceof Error ? error.message : String(error);
            failureReason = failureReason ?? `${symbol}: ${message}`;
            symbolOutcomes.push({
                symbol,
                measurementBasis: series.synthetic ? "pair_neutral_log" : "cash",
                returnPercent: Number.NaN,
                totalTrades: 0,
                scoredStartLabel: isoLabel(toUnixSecOrNull(scoredRange.startBarTime)!),
                scoredEndLabel: isoLabel(toUnixSecOrNull(scoredRange.endBarTime)!),
                warmupBars: forwardStart,
                error: message,
            });
        }
    }

    const validReturns = symbolOutcomes
        .filter((outcome) => !outcome.error && Number.isFinite(outcome.returnPercent))
        .map((outcome) => outcome.returnPercent);
    const complete = !failed && validReturns.length === args.histEndBySymbol.size;
    // Window bounds are the UNION across symbols: with mixed calendars the
    // per-symbol scored bounds legitimately differ, so presenting one symbol's
    // range as the window's would understate the span.
    const boundSecs = (labels: Array<string | undefined>, pick: (values: number[]) => number): number | null => {
        const values = labels
            .filter((label): label is string => Boolean(label))
            .map((label) => toUnixSecOrNull(label as Time))
            .filter((value): value is number => value !== null);
        return values.length > 0 ? pick(values) : null;
    };
    const startSec = boundSecs(symbolOutcomes.map((outcome) => outcome.scoredStartLabel), (values) => Math.min(...values));

    return {
        checkpointIndex: args.checkpoint.index,
        checkpointLabel: args.checkpoint.label,
        identityKey: args.candidate.identityKey,
        strategyKey: args.candidate.strategyKey,
        strategyName: args.candidate.strategyName,
        params: args.candidate.entryParams,
        ...(args.candidate.exitStrategyKey
            ? {
                exitStrategyKey: args.candidate.exitStrategyKey,
                exitStrategyName: args.candidate.exitStrategyName,
                exitStrategyParams: args.candidate.exitStrategyParams,
            }
            : {}),
        status: complete ? "measured" : (failed ? "failed" : "incomplete_horizon"),
        ...(complete ? {} : { reason: failureReason ?? "incomplete forward horizon" }),
        windowReturnPercent: complete ? computeWindowReturnPercent(validReturns) : null,
        totalTrades: symbolOutcomes.reduce((sum, outcome) => sum + (Number.isFinite(outcome.totalTrades) ? outcome.totalTrades : 0), 0),
        forwardStartSec: startSec,
        forwardEndSec: boundSecs(symbolOutcomes.map((outcome) => outcome.scoredEndLabel), (values) => Math.max(...values)),
        symbols: symbolOutcomes,
    };
}

// ---------------------------------------------------------------------------
// Report assembly helpers
// ---------------------------------------------------------------------------

function appendUnselectedSorts(
    report: MonthlyRankReplayReport,
    replayed: MonthlyRankReplaySortCoverage[],
    checkpoint: { index: number; label: string },
    reason: string,
): void {
    for (const sort of replayed) {
        report.selections.push({
            checkpointIndex: checkpoint.index,
            checkpointLabel: checkpoint.label,
            sortKey: sort.key,
            sortLabel: sort.label,
            direction: sort.direction,
            score: null,
            aggregationLabel: sort.label,
            historicalActiveSymbols: 0,
            historicalSharpeContributors: 0,
            status: "no_selection",
            reason,
        });
    }
}

function buildSortSummaries(
    report: MonthlyRankReplayReport,
    replayed: MonthlyRankReplaySortCoverage[],
    scheduledCheckpoints: number,
) {
    return replayed.map((sort) => {
        const selections = report.selections.filter((selection) => selection.sortKey === sort.key);
        const validReturns: number[] = [];
        let zeroTradeValid = 0;
        const excludedReasons: string[] = [];
        for (const selection of selections) {
            if (
                selection.status === "measured"
                && selection.forwardOutcomeIndex !== undefined
                && selection.forwardReturnPercent !== null
                && selection.forwardReturnPercent !== undefined
                && Number.isFinite(selection.forwardReturnPercent)
            ) {
                validReturns.push(selection.forwardReturnPercent);
                const outcome = report.forwardOutcomes[selection.forwardOutcomeIndex];
                if (outcome && outcome.totalTrades === 0) zeroTradeValid += 1;
            } else {
                excludedReasons.push(selection.reason ?? selection.status);
            }
        }
        // Paired random-choice comparisons: valid comparisons only. If
        // comparison coverage differs from Top 1 coverage the summary's
        // pairedTop1MeanForwardReturnPercent carries the like-for-like mean.
        const comparisons = selections
            .filter((selection) => selection.comparison?.status === "measured"
                && selection.forwardReturnPercent !== null
                && selection.forwardReturnPercent !== undefined
                && Number.isFinite(selection.forwardReturnPercent)
                && Number.isFinite(selection.comparison.randomExpectedReturnPercent ?? NaN)
                && Number.isFinite(selection.comparison.excessReturnPercent ?? NaN))
            .map((selection) => ({
                top1Return: selection.forwardReturnPercent!,
                randomExpected: selection.comparison!.randomExpectedReturnPercent!,
                excess: selection.comparison!.excessReturnPercent!,
            }));
        return summarizeMonthlyRankReplaySort({
            coverage: sort,
            scheduledCheckpoints,
            validReturns,
            zeroTradeValid,
            excludedReasons,
            comparisons,
        });
    });
}

function buildCoverageOnlyReport(
    input: FinderMonthlyRankReplayRunInput,
    replay: MonthlyRankReplayOptions,
    symbols: string[],
    replayed: MonthlyRankReplaySortCoverage[],
    excluded: ReturnType<typeof resolveMonthlyRankReplaySortCoverage>["excluded"],
    capital: ReturnType<typeof resolveCapitalSettingsFromRaw>,
    seriesBySymbol: Map<string, ReplaySymbolSeries>,
    symbolLoadErrors: Map<string, string>,
): MonthlyRankReplayReport {
    const report: MonthlyRankReplayReport = {
        kind: "monthly_rank_replay",
        runId: input.runId,
        experiment: {
            fromYear: replay.fromYear,
            evalWindowBars: replay.evalWindowBars,
            forwardBars: replay.forwardBars,
            interval: input.interval,
            symbols,
            strategyKeys: input.selectedStrategies.map((strategy) => strategy.key),
            replayedSorts: replayed.map((sort) => ({ key: sort.key, label: sort.label, direction: sort.direction })),
            excludedSorts: excluded,
            engine: "typescript",
            sizingMode: "fixed",
            capitalSettings: capital as unknown as Record<string, unknown>,
            candidatePool: {
                requestedRunsPerStrategy: Math.max(1, Math.floor(input.options.maxRuns || 0)),
                actualCandidates: 0,
                seed: typeof input.options.randomSeed === "number" ? input.options.randomSeed : null,
            },
            conventions: {
                checkpoint: "UTC month boundary; a bar is closed when barOpenTime + intervalDuration <= checkpoint",
                historicalWindow: "last L closed bars per symbol; earlier closed bars are indicator warmup only",
                forwardWindow:
                    "H bars starting with the first bar after the checkpoint's last closed bar; on intervals not aligned to the boundary that first bar may open before the boundary (its close and all fills still occur at/after it); fresh flat account",
                signalPolicy:
                    "signal must originate in the scored region AND resolve inside it; terminal liquidation at the final scored close with commission + direction-correct slippage",
                accounting:
                    "equal-weight mean of per-symbol scored returns; pair-neutral transform for synthetic pairs",
                    baseline:
                        "per sort: randomExpectedReturn = equal-weight mean of that sort's eligible configurations' forward returns at the same checkpoint (winner included)",
            },
        },
        checkpoints: [],
        symbolCoverage: symbols.map((symbol) => {
            const series = seriesBySymbol.get(symbol);
            const error = symbolLoadErrors.get(symbol);
            // The schedule is not computed on this path; warmup is reported
            // against January of the From year (the first scheduled
            // checkpoint), matching the main path's reference point.
            let warmupBars = 0;
            if (series) {
                const referenceCheckpointSec = Date.UTC(replay.fromYear, 0, 1) / 1000;
                for (let i = series.data.length - 1; i >= 0; i -= 1) {
                    const openSec = toUnixSecOrNull(series.data[i]!.time);
                    const closeSec = openSec === null ? null : resolveBarCloseTimeSec(openSec, input.interval);
                    if (closeSec !== null && closeSec <= referenceCheckpointSec) {
                        warmupBars = Math.max(0, i + 1 - replay.evalWindowBars);
                        break;
                    }
                }
            }
            return {
                symbol,
                bars: series?.bars ?? 0,
                firstOpenLabel: series?.firstOpenSec !== null && series?.firstOpenSec !== undefined
                    ? isoLabel(series.firstOpenSec)
                    : undefined,
                lastCloseLabel: series?.lastCloseSec !== null && series?.lastCloseSec !== undefined
                    ? isoLabel(series.lastCloseSec)
                    : undefined,
                warmupBarsAtFirstCheckpoint: warmupBars,
                synthetic: series?.synthetic ?? isSyntheticPairFinderSymbol(symbol),
                ...(error ? { error } : {}),
            };
        }),
        forwardOutcomes: [],
        selections: [],
        sortSummaries: [],
    };
    for (const sort of replayed) {
        report.sortSummaries.push(summarizeMonthlyRankReplaySort({
            coverage: sort,
            scheduledCheckpoints: 0,
            validReturns: [],
            zeroTradeValid: 0,
            excludedReasons: ["no measurable checkpoint"],
            comparisons: [],
        }));
    }
    return report;
}

function buildCancelledReport(
    input: FinderMonthlyRankReplayRunInput,
    replay: MonthlyRankReplayOptions,
    symbols: string[],
    replayed: MonthlyRankReplaySortCoverage[],
    excluded: ReturnType<typeof resolveMonthlyRankReplaySortCoverage>["excluded"],
    capital: ReturnType<typeof resolveCapitalSettingsFromRaw>,
): MonthlyRankReplayReport {
    const report = buildCoverageOnlyReport(input, replay, symbols, replayed, excluded, capital, new Map(), new Map());
    report.stoppedEarly = { reason: "cancelled", completedCheckpoints: 0 };
    return report;
}
