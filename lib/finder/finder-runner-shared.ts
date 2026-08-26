import {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    buildEntryBacktestDiagnostics,
    buildEntryBacktestResult,
    precomputeIndicators,
    runBacktest,
    applySignalPolarity,
} from "../strategies/index";
import { calculateSharpeRatioFromEquityCurve, calculateSharpeRatioFromReturns } from "../strategies/performance-metrics";

import { hasNonZeroSnapshotFilter } from "../rust-settings-sanitizer";
import { selectExecutionAwareClosedCandles } from "../alert-evaluation-window";
import { debugLogger } from "../debug-logger";
import { applyConfirmationStrategiesToSignals } from "../confirmation-signal-filter";
import {
    getPreparedFinderData,
    type CandidateResult,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import { mergeExitStrategySignals } from "../exit-strategy-merge";
import { splitExitStrategyParams } from "./exit-strategy-param-prefix";
import { executeBacktestStrategySignals } from "../strategy-signal-execution";
import type { CapitalSettings } from "../types/backtest";
import type { FinderOptions, FinderResult } from "../types/finder";
import type { StrategyExecutionContext } from "../types/strategies";
import { computeExitAlpha, filterStrategyExitSignals } from "./finder-exit-alpha";

export function buildFinderEvaluationData(
    data: OHLCVData[],
    interval: string,
    settings: BacktestSettings
): OHLCVData[] {
    return selectExecutionAwareClosedCandles(
        data,
        interval,
        settings,
        {
            nowSec: Math.floor(Date.now() / 1000),
            minClosedCandles: 1,
            fallbackToTrimmedClosed: true,
        }
    ) ?? data;
}

export type StrategyPlan = {
    key: string;
    name: string;
    strategy: Strategy;
    paramSets: StrategyParams[];
    /** Pre-loaded exit strategy for Exit Strategy Override; undefined when override is off. */
    exitStrategy?: Strategy;
    /** Registry key for the pre-loaded exit strategy. */
    exitStrategyKey?: string;
};

export type ParamJob = {
    id: number;
    key: string;
    name: string;
    params: StrategyParams;
    backtestSettings: BacktestSettings;
    rustBacktestSettings: BacktestSettings;
    strategy: Strategy;
    /** Pre-loaded exit strategy for Exit Strategy Override; undefined when override is off. */
    exitStrategy?: Strategy;
    /** Registry key for the pre-loaded exit strategy. */
    exitStrategyKey?: string;
};

export type FinderDatasetFlags = {
    dataSize: number;
    isLargeDataset: boolean;
    isVeryLargeDataset: boolean;
    isExtremeDataset: boolean;
    compactBacktestThreshold: number;
    shouldUseCompactBacktest: boolean;
    rustCompactMode: boolean;
    batchSize: number;
    isHeavyFinderConfig: boolean;
};

export type PreparedRun = {
    id: string;
    job: ParamJob;
    signals: Signal[];
};

export type FinderBacktestFn = (
    data: OHLCVData[],
    signals: Signal[],
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    settings?: BacktestSettings,
    sizing?: Parameters<typeof runBacktest>[6],
    precomputed?: ReturnType<typeof precomputeIndicators>,
    options?: Parameters<typeof runBacktest>[8]
) => BacktestResult;

export type FinderSignalTiming = {
    preparedDataMs: number;
    signalExecutionMs: number;
    confirmationMs: number;
    totalMs: number;
    signalCount: number;
    usedPreparedData: boolean;
};

/**
 * Backtest runner used by the polymarket-class finder runners. Forces
 * `includeAdvancedAnalytics: false` (finder candidates don't need heavy
 * analytics) and forwards the optional fast-path flags. Both polymarket and
 * second-market runners duplicated this wrapper with identical behavior.
 */
export const runFinderCandidateBacktest: typeof runBacktest = (
    data,
    signals,
    initialCapital,
    positionSizePercent,
    commissionPercent,
    settings,
    sizing,
    precomputed,
    options,
) => runBacktest(
    data,
    signals,
    initialCapital,
    positionSizePercent,
    commissionPercent,
    settings,
    sizing,
    precomputed,
    {
        includeAdvancedAnalytics: false,
        includeSharpeRatio: options?.includeSharpeRatio,
        collectDiagnostics: options?.collectDiagnostics,
        omitEquityCurve: options?.omitEquityCurve,
        skipDrawdown: options?.skipDrawdown,
        forceDisableSignalExits: options?.forceDisableSignalExits,
    },
);

export function generateSignalsForJob(
    job: ParamJob,
    data: OHLCVData[],
    interval: string,
    preparedDataCache?: FinderPreparedDataCache,
    preparedSettings?: BacktestSettings,
    executionContext?: StrategyExecutionContext,
    onTiming?: (timing: FinderSignalTiming) => void
): Signal[] {
    const startedAt = performance.now();
    let preparedDataMs = 0;
    let signalExecutionMs = 0;
    let confirmationMs = 0;
    let preparedFinderData: unknown;
    const signalSettings = job.backtestSettings;
    const preparedDataSettings = preparedSettings ?? job.backtestSettings;
    const canUsePreparedData = preparedDataCache !== undefined
        && signalSettings.strategyTimeframeEnabled !== true
        && Boolean(job.strategy.executePrepared && job.strategy.prepareFinderData);

    if (canUsePreparedData && preparedDataCache) {
        const preparedStartedAt = performance.now();
        preparedFinderData = getPreparedFinderData(preparedDataCache, job.key, job.strategy, data, preparedDataSettings, executionContext);
        preparedDataMs = performance.now() - preparedStartedAt;
    }
    const signalStartedAt = performance.now();
    const rawSignals = canUsePreparedData && job.strategy.executePrepared
        ? job.strategy.executePrepared(preparedFinderData, job.params, data, executionContext)
        : executeBacktestStrategySignals({
            data,
            interval,
            strategy: job.strategy,
            params: job.params,
            settings: signalSettings,
            executionContext,
    });
    signalExecutionMs = performance.now() - signalStartedAt;
    const confirmationStartedAt = performance.now();
    const confirmationSettings = signalSettings.strategyTimeframeEnabled
        ? { ...signalSettings, strategyTimeframeEnabled: false }
        : signalSettings;
    const signals = applyConfirmationStrategiesToSignals({
        data,
        baseSignals: canUsePreparedData ? applySignalPolarity(rawSignals, signalSettings) : rawSignals,
        settings: signalSettings,
        executeStrategy: (_key, confirmationStrategy, confirmationParams) => executeBacktestStrategySignals({
            data,
            interval,
            strategy: confirmationStrategy,
            params: confirmationParams,
            settings: confirmationSettings,
        }),
    });
    confirmationMs = performance.now() - confirmationStartedAt;
    onTiming?.({
        preparedDataMs,
        signalExecutionMs,
        confirmationMs,
        totalMs: performance.now() - startedAt,
        signalCount: signals.length,
        usedPreparedData: canUsePreparedData,
    });
    return signals;
}

export function runStrategyBacktest(args: {
    strategy: Strategy;
    data: OHLCVData[];
    signals: Signal[];
    params: StrategyParams;
    capitalSettings: CapitalSettings;
    backtestSettings: BacktestSettings;
    backtestFn: FinderBacktestFn;
    precomputed?: ReturnType<typeof precomputeIndicators>;
    backtestOptions?: Parameters<typeof runBacktest>[8];
    /** Pre-loaded exit strategy. When present, its params (under `_exit__` prefix in args.params) are split out, its signals generated and tagged exitOnly, and merged into args.signals. */
    exitStrategy?: Strategy;
    executionContext?: StrategyExecutionContext;
    /** Calculate the raw normal-vs-control Exit Alpha pair when enabled. */
    exitAlphaEnabled?: boolean;
    onExitAlpha?: (value: number | undefined) => void;
}): BacktestResult {
    const {
        strategy,
        data,
        signals,
        params,
        capitalSettings,
        backtestSettings,
        backtestFn,
        precomputed,
        exitStrategy,
        executionContext,
    } = args;
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount, advancedSizing } = capitalSettings;
    const evaluationStartedAt = performance.now();
    const evaluation = strategy.evaluate?.(data, params, signals);
    const evaluationMs = performance.now() - evaluationStartedAt;
    const entryStats = evaluation?.entryStats;

    // Exit Strategy Override: split prefixed exit params, generate close-only exit signals, merge.
    const effectiveSignals = exitStrategy
        ? mergeExitStrategySignals(signals, generateExitStrategySignals(exitStrategy, params, data, backtestSettings, executionContext))
        : signals;

    if (strategy.metadata?.role === "entry" && entryStats) {
        return buildEntryBacktestResult(
            entryStats,
            args.backtestOptions?.collectDiagnostics
                ? buildEntryBacktestDiagnostics({
                    entryStats,
                    inputBars: data.length,
                    inputSignals: signals.length,
                    elapsedMs: evaluationMs,
                })
                : undefined
        );
    }

    const normalResult = backtestFn(
        data,
        effectiveSignals,
        initialCapital,
        positionSize,
        commission,
        backtestSettings,
        { mode: sizingMode, fixedTradeAmount, advancedSizing },
        precomputed,
        args.backtestOptions
    );
    if (args.exitAlphaEnabled === true) {
        try {
            const controlOptions = {
                ...(args.backtestOptions ?? {}),
                endpointSelectionLastDataTime: undefined,
                endpointSelectionInitialCapital: undefined,
                forceDisableSignalExits: true,
            };
            const noStrategyExitResult = backtestFn(
                data,
                filterStrategyExitSignals(effectiveSignals),
                initialCapital,
                positionSize,
                commission,
                backtestSettings,
                { mode: sizingMode, fixedTradeAmount, advancedSizing },
                precomputed,
                controlOptions,
            );
            args.onExitAlpha?.(computeExitAlpha(normalResult, noStrategyExitResult));
        } catch {
            // A failed counterfactual is intentionally missing, not zero.
            args.onExitAlpha?.(undefined);
        }
    }
    return normalResult;
}

/**
 * Generates close-only exit signals from a pre-loaded exit strategy for one Finder candidate.
 * Splits the `_exit__`-prefixed params out of the combined candidate params, normalizes them
 * through the exit strategy's own normalizer, and runs its executor. Returned signals are NOT
 * tagged here; the caller (mergeExitStrategySignals) tags them exitOnly.
 */
function generateExitStrategySignals(
    exitStrategy: Strategy,
    combinedParams: StrategyParams,
    data: OHLCVData[],
    backtestSettings: BacktestSettings,
    executionContext?: StrategyExecutionContext
): Signal[] {
    const { exitParams } = splitExitStrategyParams(combinedParams);
    const normalizedExitParams = exitStrategy.normalizeParams
        ? exitStrategy.normalizeParams(exitParams)
        : exitParams;
    const rawSignals = exitStrategy.executePrepared
        ? exitStrategy.executePrepared(
            exitStrategy.prepareFinderData?.(data, backtestSettings, executionContext),
            normalizedExitParams,
            data,
            executionContext
        )
        : exitStrategy.execute(data, normalizedExitParams, executionContext);
    return applyConfirmationStrategiesToSignals({
        data,
        baseSignals: applySignalPolarity(rawSignals, backtestSettings),
        settings: backtestSettings,
    });
}

export function buildFinderResult(args: {
    key: string;
    name: string;
    params: StrategyParams;
    result: BacktestResult;
    exitStrategyKey?: string;
    selectionResult?: BacktestResult;
    compositeEdgeRatio?: number;
    exitAlpha?: number;
    endpointAdjusted?: boolean;
    endpointRemovedTrades?: number;
}): FinderResult {
    const {
        key,
        name,
        params,
        result,
        exitStrategyKey,
        selectionResult,
        compositeEdgeRatio,
        exitAlpha,
        endpointAdjusted,
        endpointRemovedTrades,
    } = args;
    const { entryParams, exitParams } = exitStrategyKey
        ? splitExitStrategyParams(params)
        : { entryParams: params, exitParams: {} };
    return {
        key,
        name,
        params: entryParams,
        ...(exitStrategyKey ? { exitStrategyKey, exitStrategyParams: exitParams } : {}),
        result,
        selectionResult: selectionResult ?? result,
        compositeEdgeRatio,
        ...(Number.isFinite(exitAlpha) ? { exitAlpha } : {}),
        endpointAdjusted: endpointAdjusted ?? false,
        endpointRemovedTrades: endpointRemovedTrades ?? 0,
    };
}

export function runBacktestAndInsert(
    data: OHLCVData[],
    signals: Signal[],
    job: ParamJob,
    backtestFn: FinderBacktestFn,
    capitalSettings: CapitalSettings,
    backtestSettings: BacktestSettings,
    precomputed: ReturnType<typeof precomputeIndicators>,
    insertResult: (candidate: CandidateResult) => void,
    onResult?: (result: BacktestResult) => void,
    onFailure?: (error: unknown) => void,
    exitAlphaEnabled = false,
): boolean {
    try {
        let exitAlpha: number | undefined;
        const result = runStrategyBacktest({
            strategy: job.strategy,
            data,
            signals,
            params: job.params,
            capitalSettings,
            backtestSettings,
            backtestFn,
            precomputed,
            backtestOptions: { collectDiagnostics: true },
            exitStrategy: job.exitStrategy,
            exitAlphaEnabled,
            onExitAlpha: (value) => {
                exitAlpha = value;
            },
        });
        onResult?.(result);
        insertResult({
            key: job.key,
            name: job.name,
            params: job.params,
            exitStrategyKey: job.exitStrategyKey,
            result,
            ...(Number.isFinite(exitAlpha) ? { exitAlpha } : {}),
        });
        return true;
    } catch (error) {
        debugLogger.warn(`[Finder] Backtest failed for ${job.key}`, {
            error: error instanceof Error ? error.message : String(error),
        });
        onFailure?.(error);
        return false;
    }
}

function hasHeavySnapshotFilters(settings: BacktestSettings): boolean {
    return hasNonZeroSnapshotFilter(settings);
}

export function computeDatasetFlags(
    dataSize: number,
    settings: BacktestSettings,
    options: FinderOptions,
    hasConfirmationStrategies: boolean
): FinderDatasetFlags {
    const isLargeDataset = dataSize > 500_000;
    const isVeryLargeDataset = dataSize > 2_000_000;
    const isExtremeDataset = dataSize > 4_000_000;
    const hasSnapshotFilters = hasHeavySnapshotFilters(settings);
    const hasHeavyTradeFiltering = options.tradeFilterEnabled && options.minTrades >= 1_000;
    const isHeavyFinderConfig = hasSnapshotFilters || hasHeavyTradeFiltering || hasConfirmationStrategies;
    const compactBacktestThreshold = options.mode === "random"
        ? (isHeavyFinderConfig ? 50_000 : 100_000)
        : (isHeavyFinderConfig ? 50_000 : 500_000);
    const shouldUseCompactBacktest = dataSize >= compactBacktestThreshold;

    const batchSize = isExtremeDataset
        ? 1
        : isVeryLargeDataset
            ? 2
            : isLargeDataset
                ? 8
                : isHeavyFinderConfig
                    ? 12
                    : 64;

    return {
        dataSize,
        isLargeDataset,
        isVeryLargeDataset,
        isExtremeDataset,
        compactBacktestThreshold,
        shouldUseCompactBacktest,
        rustCompactMode: shouldUseCompactBacktest,
        batchSize,
        isHeavyFinderConfig,
    };
}

export function normalizeResultSharpe(result: BacktestResult): BacktestResult {
    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        result.sharpeRatio = calculateSharpeRatioFromEquityCurve(result.equityCurve);
    } else if (Array.isArray(result.trades) && result.trades.length > 0) {
        result.sharpeRatio = calculateSharpeRatioFromReturns(result.trades.map((trade) => trade.pnlPercent));
    }

    return result;
}

export function isBacktestResultConsistent(result: BacktestResult): boolean {
    const totalTrades = result.totalTrades;
    if (totalTrades !== result.winningTrades + result.losingTrades) return false;
    if (totalTrades <= 0) return true;

    const expectedWinRate = (result.winningTrades / totalTrades) * 100;
    if (Math.abs(expectedWinRate - result.winRate) > 1) return false;

    const expectedAvgTrade = result.netProfit / totalTrades;
    const tolerance = Math.max(0.01, Math.abs(expectedAvgTrade) * 0.15);
    if (Math.abs(expectedAvgTrade - result.avgTrade) > tolerance) return false;

    if (!Number.isFinite(result.sharpeRatio)) return false;
    if (Math.abs(result.sharpeRatio) > 8) return false;

    return true;
}

export function normalizeSeed(seed: number | undefined): number {
    if (!Number.isFinite(seed)) return 1;
    const normalized = (Math.floor(Number(seed)) >>> 0);
    return normalized === 0 ? 1 : normalized;
}

export function deriveStrategySeed(seed: number | undefined, strategyKey: string): number {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < strategyKey.length; i++) {
        hash ^= strategyKey.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (normalizeSeed(seed) ^ hash) >>> 0;
}

export interface FinderProgressState {
    lastUiUpdateAt: number;
    lastResultsUpdateAt: number;
}

export async function maybeUpdateFinderProgress(args: {
    processedCount: number;
    totalCount: number;
    filteredCount: number;
    callbacks: import("./finder-runner").FinderRunCallbacks;
    ranker: import("./finder-result-ranker").FinderResultRanker;
    topN: number;
    timings: import("./finder-diagnostics").FinderDiagnosticsTimings;
    state: FinderProgressState;
    label?: string;
    yieldEveryN?: number;
}): Promise<void> {
    const {
        processedCount,
        totalCount,
        filteredCount,
        callbacks,
        ranker,
        topN,
        timings,
        state,
        label = "evaluations",
        yieldEveryN = 1024,
    } = args;
    const now = performance.now();
    if (now - state.lastUiUpdateAt > 250 || processedCount === totalCount) {
        state.lastUiUpdateAt = now;
        const progress = 10 + (processedCount / totalCount) * 85;
        callbacks.setProgress(progress, `${processedCount}/${totalCount} ${label}`);
        callbacks.setStatus(`Evaluating ${processedCount}/${totalCount} candidates (${filteredCount} matched)...`);
    }
    if (now - state.lastResultsUpdateAt > 750 || processedCount === totalCount) {
        state.lastResultsUpdateAt = now;
        const uiStartedAt = performance.now();
        callbacks.onResultsUpdate(ranker.toSortedArray(topN));
        timings.uiUpdates += performance.now() - uiStartedAt;
    }
    if (processedCount % yieldEveryN === 0 || processedCount === totalCount) {
        const yieldStartedAt = performance.now();
        await callbacks.yieldControl();
        timings.yielding += performance.now() - yieldStartedAt;
    }
}
