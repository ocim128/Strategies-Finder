import { executeBacktest } from "../backtest-executor";
import { mapWithConcurrencyLimit } from "../async-pool";
import type { CrossSymbolDataFetcher } from "../cross-symbol-runtime";
import { debugLogger } from "../debug-logger";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import type { CapitalSettings } from "../types/backtest";
import type {
    FinderOptions,
    FinderDiagnostics,
    FinderUniverseCandidate,
    FinderUniverseEarlyStopReason,
    FinderUniverseOptions,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type {
    BacktestSettings,
    BacktestResult,
    OHLCVData,
    Strategy,
    Time,
} from "../types/strategies";
import {
    buildFinderSearchBaseParams,
    getPreparedFinderData,
    normalizeFinderCandidateParamSets,
    resolveFinderRiskOverrides,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import {
    addElapsed,
    buildFinderDiagnostics,
    createEmptyFinderDiagnosticsTimings,
    createFinderRunId,
    getFinderStrategyDiagnosticsStats,
    recordFinderStrategyFailure,
    recordFinderStrategyNoSignals,
    toFinderFailureDiagnostics,
    toFinderStrategyDiagnostics,
    type FinderStrategyDiagnosticsStats,
} from "./finder-diagnostics";
import { buildFinderUniverseCandidate, passesFinderUniverseFilters, sortFinderUniverseCandidates } from "./finder-universe-metrics";
import type { FinderSelectedStrategy } from "./finder-runner";

const UNIVERSE_DATA_LOAD_CONCURRENCY = 12;
const UNIVERSE_DATA_LOAD_YIELD_EVERY = 8;
const UNIVERSE_EVALUATION_YIELD_EVERY_RUNS = 64;
const UNIVERSE_EVALUATION_YIELD_MIN_MS = 100;

interface FinderUniverseLoadedSymbol {
    symbol: string;
    data: OHLCVData[];
    barCount: number;
    firstTime?: Time;
    lastTime?: Time;
    maxPossibleTrades: number;
}

export interface FinderUniverseRunInput {
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    capitalSettings: CapitalSettings;
    selectedStrategy: FinderSelectedStrategy;
    loadDataset: (symbol: string, interval: string, signal?: AbortSignal) => Promise<OHLCVData[]>;
    getProvider?: (symbol: string) => string;
    generateParamSets: (defaultParams: Record<string, number>, options: FinderOptions) => Record<string, number>[];
}

export interface FinderUniverseRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    onResultsUpdate?: (results: FinderUniverseCandidate[]) => void;
}

export interface FinderUniverseRunOutput {
    results: FinderUniverseCandidate[];
    loadedSymbols: number;
    failedSymbols: string[];
    diagnostics?: FinderDiagnostics;
}

type FinderUniverseTimingSummary = {
    totalRunMs: number;
    loadMs: number;
    evaluationMs: number;
    symbolCount: number;
    loadedSymbolCount: number;
    candidateCount: number;
    keptCandidateCount: number;
};

type FinderUniversePartialCounts = {
    activeSymbols: number;
    profitableSymbols: number;
    totalTrades: number;
};

type FinderUniverseLoadOutcome =
    | { status: "loaded"; symbol: FinderUniverseLoadedSymbol }
    | { status: "failed"; symbol: string; result: FinderUniverseSymbolResult }
    | { status: "cancelled"; symbol: string };

function createPreparedStrategy(
    strategyKey: string,
    strategy: Strategy,
    cache: FinderPreparedDataCache,
    settings: BacktestSettings,
    onTiming?: (timing: { preparedDataMs: number; signalExecutionMs: number; totalMs: number; signalCount: number; usedPreparedData: boolean }) => void
): Strategy {
    const canUsePreparedData = Boolean(strategy.prepareFinderData && strategy.executePrepared);

    const wrapped = Object.create(Object.getPrototypeOf(strategy)) as Strategy;
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(strategy));
    wrapped.execute = (data, params, executionContext) => {
        const startedAt = performance.now();
        let preparedDataMs = 0;
        let signalExecutionMs = 0;
        let signals: ReturnType<Strategy["execute"]> | undefined;
        try {
            if (canUsePreparedData) {
                let prepared: unknown;
                const preparedStartedAt = performance.now();
                try {
                    prepared = getPreparedFinderData(
                        cache,
                        strategyKey,
                        strategy,
                        data,
                        settings,
                        executionContext
                    );
                } finally {
                    preparedDataMs = performance.now() - preparedStartedAt;
                }

                const signalStartedAt = performance.now();
                try {
                    signals = strategy.executePrepared!(prepared, params, data, executionContext);
                } finally {
                    signalExecutionMs = performance.now() - signalStartedAt;
                }
            } else {
                const signalStartedAt = performance.now();
                try {
                    signals = strategy.execute(data, params, executionContext);
                } finally {
                    signalExecutionMs = performance.now() - signalStartedAt;
                }
            }
            return signals ?? [];
        } finally {
            onTiming?.({
                preparedDataMs,
                signalExecutionMs,
                totalMs: performance.now() - startedAt,
                signalCount: signals?.length ?? -1,
                usedPreparedData: canUsePreparedData,
            });
        }
    };
    return wrapped;
}

function normalizeUniverseSymbols(symbols: readonly string[]): string[] {
    const unique = new Set<string>();
    for (const symbol of symbols) {
        const normalized = symbol.trim().toUpperCase();
        if (normalized) {
            unique.add(normalized);
        }
    }
    return [...unique];
}

function buildLoadFailedResult(symbol: string, error: string): FinderUniverseSymbolResult {
    return {
        symbol,
        status: "load_failed",
        barCount: 0,
        error,
    };
}

function buildRunFailedResult(symbol: FinderUniverseLoadedSymbol, error: string): FinderUniverseSymbolResult {
    return {
        symbol: symbol.symbol,
        status: "run_failed",
        barCount: symbol.barCount,
        firstTime: symbol.firstTime,
        lastTime: symbol.lastTime,
        error,
    };
}

function buildUniverseSymbolMetrics(result: BacktestResult): NonNullable<FinderUniverseSymbolResult["result"]> {
    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        expectancy: result.expectancy,
        avgTrade: result.avgTrade,
        winRate: result.winRate,
        profitFactor: result.profitFactor,
        totalTrades: result.totalTrades,
        maxDrawdownPercent: result.maxDrawdownPercent,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
    };
}

function buildSymbolResult(symbol: FinderUniverseLoadedSymbol, result: Awaited<ReturnType<typeof executeBacktest>>["result"]): FinderUniverseSymbolResult {
    let status: FinderUniverseSymbolResult["status"];
    if (result.totalTrades <= 0) {
        status = "no_trades";
    } else if (result.netProfit > 0.0001) {
        status = "profitable";
    } else if (result.netProfit < -0.0001) {
        status = "losing";
    } else {
        status = "flat";
    }

    return {
        symbol: symbol.symbol,
        status,
        barCount: symbol.barCount,
        firstTime: symbol.firstTime,
        lastTime: symbol.lastTime,
        result: buildUniverseSymbolMetrics(result),
    };
}

function resolveEarlyStopReason(args: {
    counts: FinderUniversePartialCounts;
    remainingSymbols: number;
    remainingMaxTrades: number;
    universe: FinderUniverseOptions;
}): FinderUniverseEarlyStopReason | null {
    const { counts, remainingSymbols, remainingMaxTrades, universe } = args;

    if ((counts.activeSymbols + remainingSymbols) < universe.minActiveSymbols) {
        return "unreachable_active_symbols";
    }

    if ((counts.totalTrades + remainingMaxTrades) < universe.minTotalTrades) {
        return "unreachable_total_trades";
    }

    const maxProfitableRatio = (counts.profitableSymbols + remainingSymbols)
        / Math.max(1, counts.activeSymbols + remainingSymbols);
    if (maxProfitableRatio + 0.0001 < universe.minProfitableActiveRatio) {
        return "unreachable_profitable_ratio";
    }

    return null;
}

function accumulatePartialCounts(counts: FinderUniversePartialCounts, result: FinderUniverseSymbolResult): void {
    if (!result.result || result.result.totalTrades <= 0) {
        return;
    }

    counts.activeSymbols += 1;
    counts.totalTrades += result.result.totalTrades;

    if (result.result.netProfit > 0.0001) {
        counts.profitableSymbols += 1;
    }
}

function passesUniverseFiltersFromCounts(
    counts: FinderUniversePartialCounts,
    universe: FinderUniverseOptions
): boolean {
    if (counts.activeSymbols < universe.minActiveSymbols) {
        return false;
    }
    if (counts.totalTrades < universe.minTotalTrades) {
        return false;
    }
    const profitableActiveRatio = counts.activeSymbols > 0
        ? counts.profitableSymbols / counts.activeSymbols
        : 0;
    return profitableActiveRatio >= universe.minProfitableActiveRatio;
}

function assertUniverseRunSupported(input: FinderUniverseRunInput): FinderUniverseOptions {
    const universe = input.options.universe;
    if (!universe) {
        throw new Error("Universe options are missing.");
    }
    if (input.options.mode !== "random") {
        throw new Error("Symbol Universe mode supports Random Search only in v1.");
    }
    if (input.options.polymarketScoringEnabled) {
        throw new Error("Symbol Universe mode does not support Polymarket scoring in v1.");
    }
    if (input.selectedStrategy.strategy.polymarket1sConfig) {
        throw new Error("Symbol Universe mode does not support 1s Polymarket context strategies in v1.");
    }
    if (input.options.comboEnabled) {
        throw new Error("Symbol Universe mode does not support combo mode in v1.");
    }
    if (input.options.multiTimeframeEnabled) {
        throw new Error("Symbol Universe mode does not support multi-timeframe runs in v1.");
    }
    if (input.settings.strategyTimeframeEnabled) {
        throw new Error("Symbol Universe mode does not support strategy timeframe resampling in v1.");
    }
    if (universe.symbols.length === 0) {
        throw new Error("Add at least one symbol for Symbol Universe mode.");
    }
    return universe;
}

export async function runFinderUniverseExecution(
    input: FinderUniverseRunInput,
    callbacks: FinderUniverseRunCallbacks
): Promise<FinderUniverseRunOutput> {
    const universe = assertUniverseRunSupported(input);
    const normalizedSymbols = normalizeUniverseSymbols(universe.symbols);
    if (normalizedSymbols.length === 0) {
        throw new Error("Add at least one valid symbol for Symbol Universe mode.");
    }

    const totalRunStart = performance.now();
    const runId = createFinderRunId("finder-universe");
    const timings = createEmptyFinderDiagnosticsTimings();
    const strategyStatsByKey = new Map<string, FinderStrategyDiagnosticsStats>();
    const strategyStats = getFinderStrategyDiagnosticsStats(strategyStatsByKey, input.selectedStrategy);
    const signalTimingByRun = {
        preparedDataMs: 0,
        signalMs: 0,
        totalMs: 0,
        observed: false,
    };
    let processedRuns = 0;
    let failedRuns = 0;
    const measuredYield = async (): Promise<void> => {
        const startedAt = performance.now();
        await callbacks.yieldControl();
        addElapsed(timings, "yielding", startedAt);
    };
    let loadYieldCount = 0;
    const maybeYieldDuringLoad = async (): Promise<void> => {
        loadYieldCount += 1;
        if (loadYieldCount % UNIVERSE_DATA_LOAD_YIELD_EVERY === 0) {
            await measuredYield();
        }
    };
    let evaluationsSinceYield = 0;
    let lastEvaluationYieldAt = performance.now();
    const maybeYieldDuringEvaluation = async (): Promise<void> => {
        evaluationsSinceYield += 1;
        const now = performance.now();
        if (
            evaluationsSinceYield < UNIVERSE_EVALUATION_YIELD_EVERY_RUNS
            && now - lastEvaluationYieldAt < UNIVERSE_EVALUATION_YIELD_MIN_MS
        ) {
            return;
        }

        evaluationsSinceYield = 0;
        lastEvaluationYieldAt = now;
        await measuredYield();
    };
    const loadStart = performance.now();
    const loadedSymbols: FinderUniverseLoadedSymbol[] = [];
    const loadFailures = new Map<string, FinderUniverseSymbolResult>();
    const loadCache = new Map<string, Promise<OHLCVData[]>>();
    const datasetAbort = new AbortController();

    const getOrLoadDataset = (symbol: string, interval = input.interval): Promise<OHLCVData[]> => {
        const key = `${symbol}|${interval}`;
        const cached = loadCache.get(key);
        if (cached) {
            return cached;
        }
        const promise = input.loadDataset(symbol, interval, datasetAbort.signal);
        loadCache.set(key, promise);
        return promise;
    };
    let crossSymbolDataFetcher: CrossSymbolDataFetcher | undefined;
    if (input.selectedStrategy.strategy.crossSymbolConfig) {
        if (!input.getProvider) {
            throw new Error("Symbol Universe cross-symbol runs require a provider lookup.");
        }
        crossSymbolDataFetcher = {
            getProvider: input.getProvider,
            fetchDataDetached: (symbol, interval) => getOrLoadDataset(symbol, interval),
        };
    }

    callbacks.setProgress(0, "Preparing symbol universe...");
    callbacks.setStatus("Loading universe symbols...");

    let completedLoads = 0;
    const loadOutcomes = await mapWithConcurrencyLimit(
        normalizedSymbols,
        UNIVERSE_DATA_LOAD_CONCURRENCY,
        async (symbol, index): Promise<FinderUniverseLoadOutcome> => {
            if (callbacks.isCancelled()) {
                datasetAbort.abort();
                return { status: "cancelled", symbol };
            }

            callbacks.setProgress((completedLoads / Math.max(1, normalizedSymbols.length)) * 15, `Loading ${symbol} (${index + 1}/${normalizedSymbols.length})...`);
            callbacks.setStatus(`Loading ${symbol} ${input.interval}...`);

            try {
                const data = await getOrLoadDataset(symbol, input.interval);
                if (!Array.isArray(data) || data.length === 0) {
                    return { status: "failed", symbol, result: buildLoadFailedResult(symbol, "No candles returned.") };
                }

                return {
                    status: "loaded",
                    symbol: {
                        symbol,
                        data,
                        barCount: data.length,
                        firstTime: data[0]?.time,
                        lastTime: data[data.length - 1]?.time,
                        maxPossibleTrades: data.length,
                    },
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { status: "failed", symbol, result: buildLoadFailedResult(symbol, message) };
            } finally {
                completedLoads += 1;
                callbacks.setProgress((completedLoads / Math.max(1, normalizedSymbols.length)) * 15, `Loaded ${completedLoads}/${normalizedSymbols.length} symbols...`);
                await maybeYieldDuringLoad();
            }
        }
    );

    for (const outcome of loadOutcomes) {
        if (outcome.status === "loaded") {
            loadedSymbols.push(outcome.symbol);
        } else if (outcome.status === "failed") {
            loadFailures.set(outcome.symbol, outcome.result);
        }
        if (callbacks.isCancelled()) {
            datasetAbort.abort();
            break;
        }
    }

    const loadMs = performance.now() - loadStart;
    timings.dataLoading = loadMs;
    if (callbacks.isCancelled()) {
        return {
            results: [],
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.keys()],
        };
    }

    if (loadedSymbols.length === 0) {
        throw new Error("No universe symbols could be loaded.");
    }

    const rustSettings = sanitizeBacktestSettingsForRust(input.settings);
    const paramGenerationStartedAt = performance.now();
    const baseParams = buildFinderSearchBaseParams(input.selectedStrategy.strategy, input.settings, input.options);
    const paramSets = normalizeFinderCandidateParamSets(
        input.selectedStrategy.strategy,
        input.generateParamSets(baseParams, input.options)
    );
    addElapsed(timings, "paramGeneration", paramGenerationStartedAt);
    if (paramSets.length === 0) {
        callbacks.setStatus("No valid parameter combinations generated.");
        return {
            results: [],
            loadedSymbols: loadedSymbols.length,
            failedSymbols: [...loadFailures.keys()],
        };
    }

    const evaluationStart = performance.now();
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const maxStoredSurvivors = Math.max(input.options.topN, 50);
    const survivors: FinderUniverseCandidate[] = [];
    let keptCandidateCount = 0;
    const getSortedSurvivors = (limit: number): FinderUniverseCandidate[] =>
        sortFinderUniverseCandidates(survivors, universe.sortPriority)
            .slice(0, Math.max(1, limit));
    const offerSurvivor = (candidate: FinderUniverseCandidate): void => {
        survivors.push(candidate);
        keptCandidateCount += 1;
        if (survivors.length <= maxStoredSurvivors) {
            return;
        }
        const trimmed = getSortedSurvivors(maxStoredSurvivors);
        survivors.length = 0;
        survivors.push(...trimmed);
    };
    const totalPossibleTrades = loadedSymbols.reduce((sum, item) => sum + item.maxPossibleTrades, 0);
    const totalInputBars = loadedSymbols.reduce((sum, item) => sum + item.barCount, 0);
    for (let candidateIndex = 0; candidateIndex < paramSets.length; candidateIndex += 1) {
        if (callbacks.isCancelled()) {
            break;
        }

        const params = paramSets[candidateIndex];
        const { backtestSettings } = resolveFinderRiskOverrides(input.settings, rustSettings, params, input.options);
        const preparedStrategy = createPreparedStrategy(
            input.selectedStrategy.key,
            input.selectedStrategy.strategy,
            preparedDataCache,
            backtestSettings,
            (signalTiming) => {
                signalTimingByRun.observed = true;
                signalTimingByRun.preparedDataMs += signalTiming.preparedDataMs;
                signalTimingByRun.signalMs += signalTiming.signalExecutionMs;
                signalTimingByRun.totalMs += signalTiming.totalMs;
                strategyStats.signalMs += signalTiming.signalExecutionMs;
                strategyStats.usedPreparedData = strategyStats.usedPreparedData || signalTiming.usedPreparedData;
                if (signalTiming.signalCount === 0) {
                    recordFinderStrategyNoSignals(strategyStats);
                }
            }
        );

        const symbolResults = new Map<string, FinderUniverseSymbolResult>();
        let evaluationStoppedEarly = false;
        let stoppedReason: FinderUniverseEarlyStopReason | undefined;
        const partialCounts: FinderUniversePartialCounts = {
            activeSymbols: 0,
            profitableSymbols: 0,
            totalTrades: 0,
        };
        let remainingSymbols = loadedSymbols.length;
        let remainingMaxTrades = totalPossibleTrades;

        for (let symbolIndex = 0; symbolIndex < loadedSymbols.length; symbolIndex += 1) {
            if (callbacks.isCancelled()) {
                break;
            }

            const symbol = loadedSymbols[symbolIndex];
            const progressBase = candidateIndex / Math.max(1, paramSets.length);
            const progressWithin = symbolIndex / Math.max(1, loadedSymbols.length);
            const progress = 15 + ((progressBase + (progressWithin / Math.max(1, paramSets.length))) * 85);

            callbacks.setProgress(progress, `Testing ${input.selectedStrategy.name} on ${symbol.symbol} (${candidateIndex + 1}/${paramSets.length})...`);
            callbacks.setStatus(`Evaluating candidate ${candidateIndex + 1}/${paramSets.length} on ${symbol.symbol}...`);

            const runStartedAt = performance.now();
            try {
                signalTimingByRun.preparedDataMs = 0;
                signalTimingByRun.signalMs = 0;
                signalTimingByRun.totalMs = 0;
                signalTimingByRun.observed = false;
                const output = await executeBacktest({
                    ohlcvData: symbol.data,
                    interval: input.interval,
                    primarySymbol: symbol.symbol,
                    strategyKey: input.selectedStrategy.key,
                    strategy: preparedStrategy,
                    strategyParams: params,
                    backtestSettings,
                    capitalSettings: input.capitalSettings,
                    dataFetcher: crossSymbolDataFetcher,
                    context: {
                        blockRange: null,
                        annotatePolymarket: false,
                        engineMode: "auto",
                        nowSec: Math.floor(Date.now() / 1000),
                    },
                    backtestRunOptions: {
                        includeAdvancedAnalytics: false,
                        includeSharpeRatio: false,
                        omitEquityCurve: true,
                        skipDrawdown: true,
                        skipResultPostProcessing: true,
                    },
                });
                const runMs = performance.now() - runStartedAt;
                processedRuns += 1;
                strategyStats.runs += 1;
                strategyStats.totalMs += runMs;
                strategyStats.backtestMs += Math.max(0, runMs - signalTimingByRun.totalMs);
                timings.preparedData += signalTimingByRun.preparedDataMs;
                timings.signalGeneration += signalTimingByRun.signalMs;
                timings.backtest += Math.max(0, runMs - signalTimingByRun.totalMs);
                if (output.signals.length === 0 && !signalTimingByRun.observed) {
                    recordFinderStrategyNoSignals(strategyStats);
                }
                const symbolResult = buildSymbolResult(symbol, output.result);
                symbolResults.set(symbol.symbol, symbolResult);
                accumulatePartialCounts(partialCounts, symbolResult);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const runMs = performance.now() - runStartedAt;
                processedRuns += 1;
                failedRuns += 1;
                strategyStats.runs += 1;
                strategyStats.failedRuns += 1;
                strategyStats.totalMs += runMs;
                strategyStats.backtestMs += Math.max(0, runMs - signalTimingByRun.totalMs);
                timings.preparedData += signalTimingByRun.preparedDataMs;
                timings.signalGeneration += signalTimingByRun.signalMs;
                timings.backtest += Math.max(0, runMs - signalTimingByRun.totalMs);
                recordFinderStrategyFailure(strategyStats, error);
                symbolResults.set(symbol.symbol, buildRunFailedResult(symbol, message));
            }

            remainingSymbols -= 1;
            remainingMaxTrades -= symbol.maxPossibleTrades;

            const earlyStopReason = resolveEarlyStopReason({
                counts: partialCounts,
                remainingSymbols,
                remainingMaxTrades,
                universe,
            });
            if (earlyStopReason) {
                evaluationStoppedEarly = true;
                stoppedReason = earlyStopReason;
                break;
            }

            await maybeYieldDuringEvaluation();
        }

        if (callbacks.isCancelled()) {
            break;
        }

        if (evaluationStoppedEarly) {
            await maybeYieldDuringEvaluation();
            continue;
        }

        if (!passesUniverseFiltersFromCounts(partialCounts, universe)) {
            await maybeYieldDuringEvaluation();
            continue;
        }

        const mergedSymbols: FinderUniverseSymbolResult[] = normalizedSymbols
            .map((symbol) => symbolResults.get(symbol) ?? loadFailures.get(symbol))
            .filter((entry): entry is FinderUniverseSymbolResult => Boolean(entry));

        const candidate = buildFinderUniverseCandidate({
            strategyKey: input.selectedStrategy.key,
            strategyName: input.selectedStrategy.name,
            params,
            symbols: mergedSymbols,
            evaluationStoppedEarly,
            stoppedReason,
        });

        if (passesFinderUniverseFilters(candidate, universe)) {
            const rankingStartedAt = performance.now();
            offerSurvivor(candidate);
            const updatedResults = getSortedSurvivors(input.options.topN);
            addElapsed(timings, "resultRanking", rankingStartedAt);
            if (callbacks.onResultsUpdate) {
                const uiStartedAt = performance.now();
                callbacks.onResultsUpdate(updatedResults);
                addElapsed(timings, "uiUpdates", uiStartedAt);
            }
        }

        await maybeYieldDuringEvaluation();
    }

    const finalRankingStartedAt = performance.now();
    const results = getSortedSurvivors(input.options.topN);
    addElapsed(timings, "resultRanking", finalRankingStartedAt);
    const evaluationMs = performance.now() - evaluationStart;
    timings.total = performance.now() - totalRunStart;
    const diagnostics = buildFinderDiagnostics({
        runId,
        symbol: "SYMBOL_UNIVERSE",
        interval: input.interval,
        mode: input.options.mode,
        engineMode: "symbol_universe",
        inputBars: totalInputBars,
        evaluationBars: totalInputBars,
        selectedStrategies: 1,
        totalParamRuns: paramSets.length * normalizedSymbols.length,
        batchSize: 1,
        processedRuns,
        filteredRuns: keptCandidateCount,
        shownResults: results.length,
        endpointAdjusted: 0,
        failedRuns: failedRuns + loadFailures.size,
        timings,
        strategyBreakdown: toFinderStrategyDiagnostics(strategyStatsByKey),
        failureBreakdown: toFinderFailureDiagnostics(strategyStatsByKey),
    });
    const timingSummary: FinderUniverseTimingSummary = {
        totalRunMs: performance.now() - totalRunStart,
        loadMs,
        evaluationMs,
        symbolCount: normalizedSymbols.length,
        loadedSymbolCount: loadedSymbols.length,
        candidateCount: paramSets.length,
        keptCandidateCount,
    };
    debugLogger.event("finder.universe.timing", timingSummary);
    debugLogger.event("finder.diagnostics", diagnostics);

    return {
        results,
        loadedSymbols: loadedSymbols.length,
        failedSymbols: [...loadFailures.keys()],
        diagnostics,
    };
}
