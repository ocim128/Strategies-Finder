import {
    BacktestSettings,
    OHLCVData,
    Time,
    buildEntryBacktestResult,
    precomputeIndicators,
    runBacktest,
    runBacktestCompact,
    applySignalPolarity,
} from "../strategies/index";
import type { BacktestResult, StrategyExecutionContext } from "../types/strategies";
import { rustEngine } from "../rust-engine-client";
import { shouldUseRustEngine } from "../engine-preferences";
import { debugLogger } from "../debug-logger";
import { isBuiltInKey } from "../strategies/built-in-catalog";
import { isCrossSymbolStrategy, resolveCrossSymbolExecution } from "../cross-symbol-runtime";

import { compareFinderResults } from "./finder-engine";
import { FinderResultRanker } from "./finder-result-ranker";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import type { FinderRandomBenchmark, FinderResult } from "../types/finder";
import type { CapitalSettings } from "../types/backtest";
import { applyConfirmationStrategiesToSignals } from "../confirmation-signal-filter";
import {
    attachTradeTimingQuality,
    finderSortRequiresTradeTimingQuality,
} from "../trade-timing-quality";
import {
    buildFinderSearchBaseParams,
    buildComparableFinderResult,
    compactSignalsForRust,
    computeFinderCompositeEdgeRatio,
    extractRustFinderCandidates,
    finderSortRequiresCompositeEdgeRatio,
    getPreparedFinderData,
    normalizeFinderCandidateParams,
    resolveFinderCandidateBacktestSettings,
    resolveFinderRiskOverrides,
    resolveQuickFunnelShortlistCount,
    selectPrescreenDataSlice,
    shouldUseRustCachedMode,
    type CandidateResult,
    type FinderPreparedDataCache,
    type QuickFunnelCandidate,
    type RandomBenchmarkMeta,
} from "./finder-runner-core";
import {
    applyComboMerge,
    buildFinderEvaluationData,
    buildFinderResult,
    buildSelection,
    generateSignalsForJob,
    isBacktestResultConsistent,
    normalizeResultSharpe,
    resolveEffectiveCapitalSettings,
    runBacktestAndInsert,
    runStrategyBacktest,
    type FinderBacktestFn,
    type FinderDatasetFlags,
    type FinderSignalTiming,
    type ParamJob,
    type PreparedRun,
} from "./finder-runner-shared";
import {
    buildFinderDiagnostics,
    createEmptyFinderBacktestDiagnosticsStats,
    createEmptyFinderDiagnosticsTimings,
    createFinderRunId,
    getFinderStrategyDiagnosticsStats,
    recordFinderBacktestDiagnostics,
    recordFinderStrategyFailure,
    toFinderBacktestDiagnostics,
    toFinderFailureDiagnostics,
    toFinderStrategyDiagnostics,
    type FinderDiagnosticsTimings,
    type FinderStrategyDiagnosticsStats,
} from "./finder-diagnostics";
import type { FinderRunCallbacks, FinderRunInput, FinderRunOutput } from "./finder-runner";

export { buildFinderEvaluationData } from "./finder-runner-shared";
export { resolveFinderCandidateBacktestSettings, shouldUseRustCachedMode } from "./finder-runner-core";

const RUST_NATIVE_FINDER_ENDPOINT_ENABLED = false;

let dataManagerModulePromise: Promise<typeof import("../data-manager")> | null = null;

async function getDataManager() {
    dataManagerModulePromise ??= import("../data-manager");
    return (await dataManagerModulePromise).dataManager;
}

type FinderCandidateForEnrichment = Pick<FinderResult, "key" | "name" | "params" | "result">
    & Partial<Pick<FinderResult, "comboMode" | "comboPrimaryConfigName" | "compositeEdgeRatio" | "polymarketEval">>;

function enrichFinderCandidate(args: {
    candidate: FinderCandidateForEnrichment;
    candidateData: OHLCVData[];
    lastDataTime: Time | null;
    initialCapital: number;
    requiresCompositeEdgeRatioSort: boolean;
    requiresTradeTimingQualitySort: boolean;
    comboMode?: boolean;
    comboPrimaryConfigName?: string;
}): FinderResult {
    const {
        candidate,
        candidateData,
        lastDataTime,
        initialCapital,
        requiresCompositeEdgeRatioSort,
        requiresTradeTimingQualitySort,
    } = args;
    const normalizedResult = normalizeResultSharpe(candidate.result);
    if (requiresTradeTimingQualitySort) {
        attachTradeTimingQuality(normalizedResult, candidateData);
    }
    const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);
    if (requiresTradeTimingQualitySort) {
        attachTradeTimingQuality(adjustment.result, candidateData);
    }

    return buildFinderResult({
        ...candidate,
        comboMode: args.comboMode ?? candidate.comboMode,
        comboPrimaryConfigName: args.comboPrimaryConfigName ?? candidate.comboPrimaryConfigName,
        result: normalizedResult,
        selectionResult: adjustment.result,
        compositeEdgeRatio: requiresCompositeEdgeRatioSort
            ? computeFinderCompositeEdgeRatio(normalizedResult, candidateData)
            : candidate.compositeEdgeRatio,
        endpointAdjusted: adjustment.adjusted,
        endpointRemovedTrades: adjustment.removedTrades,
    });
}

interface SingleTimeframeRunParams {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    flags: FinderDatasetFlags;
    totalRuns: number;
    nextJobBatch: (batchSize: number) => ParamJob[];
    shouldUpdateUi: (force?: boolean) => boolean;
    maybeYieldByBudget: (force?: boolean) => Promise<void>;
    capitalSettings: CapitalSettings;
    rustSettings: BacktestSettings;
    paramGenerationMs?: number;
}

type FinderEngineDecision = {
    useRustForFinder: boolean;
    useRustCached: boolean;
    canTryNativeFinder: boolean;
    cacheId: string | null;
    statusMessage: string;
    cacheRequested: boolean;
};

type RustBatchDispatchArgs = {
    batchRuns: PreparedRun[];
    closedData: OHLCVData[];
    cacheId: string | null;
    capitalSettings: CapitalSettings;
    rustSettings: BacktestSettings;
    rustCompactMode: boolean;
    insertResult: (candidate: CandidateResult) => void;
    runBacktestFallback: (run: PreparedRun) => void;
    timing: FinderDiagnosticsTimings;
    onUnknownRunId?: (id: string) => void;
    onInconsistentResult?: (run: PreparedRun) => void;
};

type RustBatchDispatchStats = {
    rustCompletedRuns: number;
    fallbackRuns: number;
};

type BacktestFallbackRunnerOptions = {
    closedData: OHLCVData[];
    backtestFn: FinderBacktestFn;
    capitalSettings: CapitalSettings;
    resolveBacktestSettings: (job: ParamJob) => BacktestSettings;
    getJobData: (job: ParamJob, defaultData: OHLCVData[]) => OHLCVData[];
    getJobPrecomputed: (job: ParamJob, defaultPrecomputed: ReturnType<typeof precomputeIndicators>) => ReturnType<typeof precomputeIndicators>;
    defaultPrecomputed: ReturnType<typeof precomputeIndicators>;
    insertResult: (candidate: CandidateResult) => void;
    timing: FinderDiagnosticsTimings;
    onBacktestResult?: (job: ParamJob, result: BacktestResult) => void;
    onFailure?: (job: ParamJob, error?: unknown) => void;
};

function createBacktestFallbackRunner(options: BacktestFallbackRunnerOptions): (run: PreparedRun) => void {
    return (run: PreparedRun): void => {
        const tTsStart = performance.now();
        const jobData = options.getJobData(run.job, options.closedData);
        runBacktestAndInsert(
            jobData,
            run.signals,
            run.job,
            options.backtestFn,
            options.capitalSettings,
            options.resolveBacktestSettings(run.job),
            options.getJobPrecomputed(run.job, options.defaultPrecomputed),
            options.insertResult,
            (result) => options.onBacktestResult?.(run.job, result),
            (error) => options.onFailure?.(run.job, error)
        );
        options.timing.backtest += performance.now() - tTsStart;
    };
}
type RustRunPreparationOptions = {
    jobs: ParamJob[];
    closedData: OHLCVData[];
    preparedDataCache: FinderPreparedDataCache;
    preparedSettings: BacktestSettings;
    input: FinderRunInput;
    getJobData: (job: ParamJob, defaultData: OHLCVData[]) => OHLCVData[];
    getJobCtx: (job: ParamJob) => StrategyExecutionContext | undefined;
    isCrossSymbolJobSkipped: (job: ParamJob) => boolean;
    insertResult: (candidate: CandidateResult) => void;
    timing: FinderDiagnosticsTimings;
    idForJob: (job: ParamJob) => string;
    mergeComboSignals: boolean;
    failureContext: string;
    onSignalTiming?: (job: ParamJob, timing: FinderSignalTiming) => void;
    onJobFailure?: (job: ParamJob, error?: unknown) => void;
};

function prepareRustBatchRuns(options: RustRunPreparationOptions): PreparedRun[] {
    const batchRuns: PreparedRun[] = [];
    const tSignalStart = performance.now();

    for (const job of options.jobs) {
        if (options.isCrossSymbolJobSkipped(job)) continue;
        try {
            const jobData = options.getJobData(job, options.closedData);
            let signals = generateSignalsForJob(
                job,
                jobData,
                options.preparedDataCache,
                options.preparedSettings,
                options.getJobCtx(job),
                (timing) => options.onSignalTiming?.(job, timing)
            );
            if (options.mergeComboSignals) {
                signals = applyComboMerge(signals, options.input);
            }

            const evaluation = job.strategy.evaluate?.(jobData, job.params, signals);
            const entryStats = evaluation?.entryStats;
            if (job.strategy.metadata?.role === "entry" && entryStats) {
                const result = buildEntryBacktestResult(entryStats);
                options.insertResult({
                    key: job.key,
                    name: job.name,
                    params: job.params,
                    result,
                });
                signals.length = 0;
                continue;
            }

            batchRuns.push({
                id: options.idForJob(job),
                job,
                signals,
            });
        } catch (error) {
            options.onJobFailure?.(job, error);
            debugLogger.warn(`[Finder] ${options.failureContext} failed for ${job.key}`, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    options.timing.signalGeneration += performance.now() - tSignalStart;
    return batchRuns;
}

async function dispatchRustBatchWithFallback(args: RustBatchDispatchArgs): Promise<RustBatchDispatchStats> {
    const {
        batchRuns,
        closedData,
        cacheId,
        capitalSettings,
        rustSettings,
        rustCompactMode,
        insertResult,
        runBacktestFallback,
        timing,
        onUnknownRunId,
        onInconsistentResult,
    } = args;
    const stats: RustBatchDispatchStats = {
        rustCompletedRuns: 0,
        fallbackRuns: 0,
    };
    const runFallback = (run: PreparedRun): void => {
        stats.fallbackRuns++;
        runBacktestFallback(run);
    };
    if (batchRuns.length === 0) {
        return stats;
    }

    const batchItems = batchRuns.map((run) => ({
        id: run.id,
        signals: compactSignalsForRust(run.signals),
        settings: run.job.rustBacktestSettings,
    }));

    const tRustStart = performance.now();
    try {
        const batchResult = cacheId
            ? await rustEngine.runCachedBatchBacktest(
                cacheId,
                batchItems,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission,
                rustSettings,
                {
                    mode: capitalSettings.sizingMode,
                    fixedTradeAmount: capitalSettings.fixedTradeAmount,
                    advancedSizing: capitalSettings.advancedSizing,
                },
                rustCompactMode
            )
            : await rustEngine.runBatchBacktest(
                closedData,
                batchItems,
                capitalSettings.initialCapital,
                capitalSettings.positionSize,
                capitalSettings.commission,
                rustSettings,
                {
                    mode: capitalSettings.sizingMode,
                    fixedTradeAmount: capitalSettings.fixedTradeAmount,
                    advancedSizing: capitalSettings.advancedSizing,
                },
                rustCompactMode
            );

        if (batchResult && batchResult.results.length > 0) {
            const runById = new Map(batchRuns.map((run) => [run.id, run]));
            const handledRunIds = new Set<string>();

            for (const batchEntry of batchResult.results) {
                const run = runById.get(batchEntry.id);
                if (!run) {
                    onUnknownRunId?.(batchEntry.id);
                    continue;
                }
                handledRunIds.add(run.id);

                if (!isBacktestResultConsistent(batchEntry.result)) {
                    onInconsistentResult?.(run);
                    runFallback(run);
                    continue;
                }

                insertResult({
                    key: run.job.key,
                    name: run.job.name,
                    params: run.job.params,
                    result: batchEntry.result,
                });
                stats.rustCompletedRuns++;
            }

            if (handledRunIds.size < batchRuns.length) {
                for (const run of batchRuns) {
                    if (!handledRunIds.has(run.id)) {
                        runFallback(run);
                    }
                }
            }
        } else {
            for (const run of batchRuns) {
                runFallback(run);
            }
        }
    } catch (_error) {
        for (const run of batchRuns) {
            runFallback(run);
        }
    } finally {
        timing.rustRequest += performance.now() - tRustStart;
        for (const run of batchRuns) {
            run.signals.length = 0;
        }
        batchRuns.length = 0;
    }
    return stats;
}

async function resolveFinderEngineDecision(args: {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    flags: FinderDatasetFlags;
    totalRuns: number;
    closedData: OHLCVData[];
    requiresCompositeEdgeRatioSort: boolean;
}): Promise<FinderEngineDecision> {
    const { input, callbacks, flags, totalRuns, closedData, requiresCompositeEdgeRatioSort } = args;
    const comboActive = Boolean(input.comboPrimarySignals);
    const rustPreferred = !comboActive && !requiresCompositeEdgeRatioSort && !input.requiresTsEngine && shouldUseRustEngine();
    const rustHealthy = rustPreferred && await rustEngine.checkHealth();
    const rustUnavailableReason = comboActive
        ? "combo mode requires TypeScript engine"
        : requiresCompositeEdgeRatioSort
            ? "Composite Edge Ratio sort requires full TypeScript trade paths"
            : !rustPreferred
                ? (input.requiresTsEngine ? "current sizing or realism settings require TypeScript" : "engine preference is TypeScript")
                : "Rust health check failed";
    const canTryNativeFinder =
        RUST_NATIVE_FINDER_ENDPOINT_ENABLED &&
        !comboActive &&
        input.options.mode === "random" &&
        rustHealthy &&
        input.selectedStrategies.length === 1 &&
        isBuiltInKey(input.selectedStrategies[0]?.key ?? "");

    if (!comboActive && input.requiresTsEngine && !rustHealthy) {
        debugLogger.info("[Finder] TypeScript-only sizing or realism settings enabled - forcing TypeScript engine.");
    }

    const cacheDecision = shouldUseRustCachedMode(flags.dataSize, totalRuns, flags.batchSize);
    let cacheId: string | null = null;
    const useCachedMode = comboActive || canTryNativeFinder ? false : cacheDecision.useCache;
    if (useCachedMode && rustHealthy) {
        const cacheReasonText = cacheDecision.reason === "large_dataset"
            ? `large dataset (${flags.dataSize} bars)`
            : `high batch count (${Math.ceil(totalRuns / flags.batchSize)} batches)`;
        callbacks.setStatus(`Caching data on Rust engine (${cacheReasonText})...`);
        callbacks.setProgress(8, "Uploading data to Rust...");
        cacheId = await rustEngine.cacheData(closedData);
        if (cacheId) {
            debugLogger.info(`[Finder] Data cached with ID: ${cacheId} (${cacheReasonText})`);
        } else {
            debugLogger.warn("[Finder] Failed to cache data, continuing with Rust direct mode.");
        }
    }

    const useRustCached = useCachedMode && cacheId !== null;
    const useRustDirect = rustHealthy && (!useCachedMode || cacheId === null);
    const useRustForFinder = (useRustCached || useRustDirect) && !comboActive;

    let statusMessage: string;
    if (flags.isExtremeDataset) {
        if (useRustForFinder) {
            debugLogger.info(`[Finder] Extreme dataset (${(flags.dataSize / 1_000_000).toFixed(1)}M bars) - using Rust mode.`);
            statusMessage = useRustCached
                ? `Using Rust engine with cached data (extreme dataset, ${(flags.dataSize / 1_000_000).toFixed(1)}M bars)...`
                : `Using Rust engine (direct mode, extreme dataset, ${(flags.dataSize / 1_000_000).toFixed(1)}M bars)...`;
        } else {
            debugLogger.info(`[Finder] Extreme dataset (${(flags.dataSize / 1_000_000).toFixed(1)}M bars) - using TypeScript ultra-memory mode`);
            statusMessage = `Ultra-memory mode: TypeScript only (${(flags.dataSize / 1_000_000).toFixed(1)}M bars)`;
        }
    } else if (useRustCached) {
        const cacheReasonText = cacheDecision.reason === "large_dataset" ? "large dataset" : "high batch count";
        statusMessage = `Using Rust engine with cached data (${cacheReasonText})...`;
    } else if (useRustForFinder) {
        statusMessage = "Using Rust engine...";
    } else {
        debugLogger.warn(`[Finder] Using TypeScript for ${flags.dataSize} bars (${rustUnavailableReason})${useCachedMode ? "" : "."}`);
        statusMessage = `Using TypeScript engine (${rustUnavailableReason})...`;
    }

    if (comboActive) {
        statusMessage = `Combo mode: TS engine (${input.comboPrimarySignals!.length} primary signals)...`;
    }

    callbacks.setStatus(statusMessage);

    return {
        useRustForFinder,
        useRustCached,
        canTryNativeFinder,
        cacheId,
        statusMessage,
        cacheRequested: cacheDecision.useCache,
    };
}

export async function runSingleTimeframe(params: SingleTimeframeRunParams): Promise<FinderRunOutput> {
    const {
        input,
        callbacks,
        flags,
        totalRuns,
        nextJobBatch,
        shouldUpdateUi,
        maybeYieldByBudget,
        capitalSettings,
        rustSettings,
        paramGenerationMs = 0,
    } = params;
    const effectiveCapitalSettings = resolveEffectiveCapitalSettings(input);
    const {
        initialCapital: effectiveInitialCapital,
    } = effectiveCapitalSettings;
    const effectiveBacktestSettings = input.comboPrimarySettings ?? input.settings;

    const timing = createEmptyFinderDiagnosticsTimings();
    timing.paramGeneration = paramGenerationMs;
    const runId = createFinderRunId("finder");
    const runStart = performance.now();
    const strategyStatsByKey = new Map<string, FinderStrategyDiagnosticsStats>();
    const backtestStats = createEmptyFinderBacktestDiagnosticsStats();
    let failedRuns = 0;

    const closedDataStartedAt = performance.now();
    const closedData = buildFinderEvaluationData(input.ohlcvData, input.interval, effectiveBacktestSettings);
    timing.closedDataSelection += performance.now() - closedDataStartedAt;
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for finder run.");
        return { results: [] };
    }
    const indicatorStartedAt = performance.now();
    const singleTfPrecomputed = precomputeIndicators(closedData, effectiveBacktestSettings);
    timing.indicatorPrecompute += performance.now() - indicatorStartedAt;
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();

    // --- Cross-symbol resolution: resolve once per unique strategy key ---
    const crossSymbolFailedKeys = new Set<string>();
    const crossSymbolContextMap = new Map<string, {
        data: OHLCVData[];
        ctx: StrategyExecutionContext | undefined;
        precomputed: ReturnType<typeof precomputeIndicators>;
    }>();
    for (const selection of input.selectedStrategies) {
        if (!isCrossSymbolStrategy(selection.strategy) || crossSymbolContextMap.has(selection.key)) continue;
        try {
            const dataManager = await getDataManager();
            const resolved = await resolveCrossSymbolExecution({
                strategy: selection.strategy,
                primarySymbol: input.symbol,
                interval: input.interval,
                primaryData: closedData,
                settings: effectiveBacktestSettings,
                dataFetcher: dataManager,
            });
            crossSymbolContextMap.set(selection.key, {
                data: resolved.primaryData,
                ctx: resolved.context,
                precomputed: precomputeIndicators(resolved.primaryData, effectiveBacktestSettings),
            });
        } catch (error) {
            debugLogger.warn(`[Finder] Cross-symbol resolution failed for ${selection.key}`, error);
            crossSymbolFailedKeys.add(selection.key);
        }
    }
    const getJobData = (job: ParamJob, defaultData: OHLCVData[]): OHLCVData[] => {
        return crossSymbolContextMap.get(job.key)?.data ?? defaultData;
    };
    const getJobCtx = (job: ParamJob): StrategyExecutionContext | undefined => {
        return crossSymbolContextMap.get(job.key)?.ctx;
    };
    const getJobPrecomputed = (job: ParamJob, defaultPrecomputed: ReturnType<typeof precomputeIndicators>): ReturnType<typeof precomputeIndicators> => {
        return crossSymbolContextMap.get(job.key)?.precomputed ?? defaultPrecomputed;
    };
    const isCrossSymbolJobSkipped = (job: ParamJob): boolean => {
        return crossSymbolFailedKeys.has(job.key);
    };

    callbacks.setProgress(10, `Running ${totalRuns} backtests (batch mode)...`);

    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    const requiresCompositeEdgeRatioSort = finderSortRequiresCompositeEdgeRatio(input.options.sortPriority);
    const requiresTradeTimingQualitySort = finderSortRequiresTradeTimingQuality(input.options.sortPriority);
    const usingCompactBacktest = !requiresCompositeEdgeRatioSort && !requiresTradeTimingQualitySort && flags.shouldUseCompactBacktest;
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
    let lastResultsUpdateAt = 0;
    const lastDataTime = closedData.length > 0 ? closedData[closedData.length - 1].time : null;
    let rustCompletedRuns = 0;
    let rustFallbackRuns = 0;
    const recordRustDispatchStats = (stats: RustBatchDispatchStats): void => {
        rustCompletedRuns += stats.rustCompletedRuns;
        rustFallbackRuns += stats.fallbackRuns;
    };
    const measuredYield = async (force = false): Promise<void> => {
        const startedAt = performance.now();
        await maybeYieldByBudget(force);
        timing.yielding += performance.now() - startedAt;
    };
    const measuredResultsUpdate = (results: FinderResult[]): void => {
        const startedAt = performance.now();
        callbacks.onResultsUpdate(results);
        timing.uiUpdates += performance.now() - startedAt;
    };
    const recordSignalTiming = (job: ParamJob, signalTiming: FinderSignalTiming): void => {
        timing.preparedData += signalTiming.preparedDataMs;
        const stats = getFinderStrategyDiagnosticsStats(strategyStatsByKey, job);
        stats.signalMs += signalTiming.totalMs;
        stats.usedPreparedData = stats.usedPreparedData || signalTiming.usedPreparedData;
    };
    const recordBacktestTiming = (job: ParamJob, durationMs: number): void => {
        getFinderStrategyDiagnosticsStats(strategyStatsByKey, job).backtestMs += durationMs;
    };
    const recordBacktestResult = (job: ParamJob, result: BacktestResult): void => {
        const stats = getFinderStrategyDiagnosticsStats(strategyStatsByKey, job);
        recordFinderBacktestDiagnostics(stats.backtest, result.diagnostics);
        recordFinderBacktestDiagnostics(backtestStats, result.diagnostics);
    };
    const recordRunTiming = (job: ParamJob, durationMs: number): void => {
        const stats = getFinderStrategyDiagnosticsStats(strategyStatsByKey, job);
        stats.runs++;
        stats.totalMs += durationMs;
    };
    const recordFailure = (job: Pick<ParamJob, "key" | "name">, error?: unknown): void => {
        failedRuns++;
        const stats = getFinderStrategyDiagnosticsStats(strategyStatsByKey, job);
        stats.failedRuns++;
        recordFinderStrategyFailure(stats, error);
    };

    const comboActive = !!input.comboPrimarySignals;
    let { useRustForFinder, canTryNativeFinder, cacheId, cacheRequested } =
        await resolveFinderEngineDecision({
            input,
            callbacks,
            flags,
            totalRuns,
            closedData,
            requiresCompositeEdgeRatioSort,
        });
    if (requiresTradeTimingQualitySort && useRustForFinder) {
        useRustForFinder = false;
        canTryNativeFinder = false;
        cacheId = null;
        cacheRequested = false;
        callbacks.setStatus("Using TypeScript engine (timing-score sort requires full trades)...");
    }

    const insertResult = (candidate: CandidateResult): void => {
        if (input.options.tradeFilterEnabled) {
            const rawTrades = candidate.result.totalTrades;
            if (rawTrades < input.options.minTrades) return;
            if (rawTrades > input.options.maxTrades && (!Array.isArray(candidate.result.trades) || candidate.result.trades.length === 0)) {
                return;
            }
        }

        const candidateData = crossSymbolContextMap.get(candidate.key)?.data ?? closedData;
        const enrichmentStartedAt = performance.now();
        const enriched = enrichFinderCandidate({
            candidate,
            candidateData,
            lastDataTime,
            initialCapital: effectiveInitialCapital,
            requiresCompositeEdgeRatioSort,
            requiresTradeTimingQualitySort,
            comboMode: Boolean(input.comboPrimarySignals),
            comboPrimaryConfigName: input.options.comboPrimaryConfigName,
        });
        timing.resultEnrichment += performance.now() - enrichmentStartedAt;

        if (input.options.tradeFilterEnabled) {
            if (enriched.result.totalTrades < input.options.minTrades || enriched.result.totalTrades > input.options.maxTrades) {
                return;
            }
        }

        filteredCount++;
        if (enriched.endpointAdjusted) {
            endpointAdjustedCount++;
        }
        const rankingStartedAt = performance.now();
        ranker.offer(enriched);
        timing.resultRanking += performance.now() - rankingStartedAt;
    };

    const finalizeRun = async (
        processedRunCount: number,
        batchCount: number,
        engineMode: string,
        benchmarkMeta?: RandomBenchmarkMeta
    ): Promise<FinderRunOutput> => {
        const reportedEngineMode = engineMode.startsWith("rust") && rustFallbackRuns > 0
            ? (rustCompletedRuns > 0 ? `${engineMode}_mixed_fallback` : "typescript_fallback")
            : engineMode;
        const finalRankingStartedAt = performance.now();
        const fastTop = ranker.toSortedArray(input.options.topN);
        timing.resultRanking += performance.now() - finalRankingStartedAt;
        let trimmed = fastTop;
        const shouldReconcileTopResults = usingCompactBacktest || useRustForFinder;
        if (shouldReconcileTopResults && fastTop.length > 0) {
            callbacks.setStatus("Reconciling top results with full backtest...");
            callbacks.setProgress(99, "Reconciling top results...");
            const reconciliationStartedAt = performance.now();
            trimmed = await reconcileSingleTimeframeTopResults(
                fastTop,
                input,
                closedData,
                effectiveCapitalSettings,
                measuredYield,
                singleTfPrecomputed,
                preparedDataCache,
                crossSymbolContextMap
            );
            timing.reconciliation += performance.now() - reconciliationStartedAt;
        }

        endpointAdjustedCount = trimmed.reduce((count, item) => count + (item.endpointAdjusted ? 1 : 0), 0);
        callbacks.setProgress(100, totalRuns > 0 ? `${totalRuns}/${totalRuns} runs` : "Complete");
        const statusParts = [`${processedRunCount} runs`];
        if (input.options.tradeFilterEnabled) {
            statusParts.push(`${filteredCount} matched`);
        }
        if (endpointAdjustedCount > 0) {
            statusParts.push(`${endpointAdjustedCount} endpoint-adjusted`);
        }
        if (rustFallbackRuns > 0) {
            statusParts.push(rustCompletedRuns > 0 ? `${rustFallbackRuns} TS fallbacks` : "Rust unavailable, TS fallback");
        }
        statusParts.push(`${trimmed.length} shown`);
        if (flags.isVeryLargeDataset) {
            statusParts.push("(memory-efficient mode)");
        }
        callbacks.setStatus(`Complete. ${statusParts.join(", ")}.`);

        timing.total = performance.now() - runStart;
        debugLogger.event('finder.timing_breakdown', {
            datasetSize: flags.dataSize,
            totalRuns,
            engineMode: reportedEngineMode,
            batchCount,
            rustCompletedRuns,
            rustFallbackRuns,
            durations: {
                signalGeneration: timing.signalGeneration,
                rustRequest: timing.rustRequest,
                backtest: timing.backtest,
                total: timing.total,
            },
        });

        let randomBenchmark: FinderRandomBenchmark | undefined;
        if (input.options.mode === "random" && benchmarkMeta) {
            const seconds = Math.max(0.001, timing.total / 1000);
            randomBenchmark = {
                pipeline: benchmarkMeta.pipeline,
                engineMode: reportedEngineMode,
                totalRuns,
                processedRuns: processedRunCount,
                prescreenRuns: benchmarkMeta.prescreenRuns,
                shortlistRuns: benchmarkMeta.shortlistRuns,
                fullRuns: benchmarkMeta.fullRuns,
                shown: trimmed.length,
                shortBars: benchmarkMeta.shortBars,
                shortCoverage: Number(benchmarkMeta.shortCoverage.toFixed(4)),
                rustCandidateCount: benchmarkMeta.rustCandidateCount,
                runsPerSecond: Number((processedRunCount / seconds).toFixed(2)),
                msPerRun: Number((timing.total / Math.max(1, processedRunCount)).toFixed(2)),
            };
            debugLogger.event("finder.random_benchmark", {
                symbol: input.symbol,
                interval: input.interval,
                ...randomBenchmark,
                rustCompletedRuns,
                rustFallbackRuns,
                durations: {
                    signalGeneration: timing.signalGeneration,
                    rustRequest: timing.rustRequest,
                    backtest: timing.backtest,
                    total: timing.total,
                },
            });
        }

        const diagnostics = buildFinderDiagnostics({
            runId,
            symbol: input.symbol,
            interval: input.interval,
            mode: input.options.mode,
            engineMode: reportedEngineMode,
            inputBars: input.ohlcvData.length,
            evaluationBars: closedData.length,
            selectedStrategies: input.selectedStrategies.length,
            totalParamRuns: totalRuns,
            batchSize: flags.batchSize,
            processedRuns: processedRunCount,
            filteredRuns: filteredCount,
            shownResults: trimmed.length,
            rustCompletedRuns,
            rustFallbackRuns,
            endpointAdjusted: endpointAdjustedCount,
            failedRuns,
            timings: timing,
            strategyBreakdown: toFinderStrategyDiagnostics(strategyStatsByKey),
            backtestDiagnostics: toFinderBacktestDiagnostics(backtestStats),
            failureBreakdown: toFinderFailureDiagnostics(strategyStatsByKey),
        });
        debugLogger.event("finder.diagnostics", diagnostics);

        return { results: trimmed, randomBenchmark, diagnostics };
    };

    const rustNativeFinderEligible = canTryNativeFinder && useRustForFinder && !comboActive;

    if (rustNativeFinderEligible) {
        const selected = input.selectedStrategies[0];
        callbacks.setStatus("Using Rust native random finder...");
        callbacks.setProgress(12, "Rust native finder running...");

        const baseParams = buildFinderSearchBaseParams(selected.strategy, input.settings, input.options);
        const rustFinderOptions = {
            mode: "random" as const,
            sortPriority: input.options.sortPriority,
            useAdvancedSort: input.options.useAdvancedSort,
            topN: Math.max(input.options.topN * 3, 30),
            steps: input.options.steps,
            rangePercent: input.options.rangePercent,
            maxRuns: input.options.maxRuns,
            tradeFilterEnabled: input.options.tradeFilterEnabled,
            minTrades: input.options.minTrades,
            maxTrades: input.options.maxTrades,
        };

        const rustRawResults = await rustEngine.runFinder(
            closedData,
            selected.key,
            baseParams,
            capitalSettings.initialCapital,
            capitalSettings.positionSize,
            capitalSettings.commission,
            rustSettings,
            rustFinderOptions,
            (progress) => {
                const percent = Number.isFinite(progress.percent) ? Math.max(12, Math.min(97, progress.percent)) : 12;
                callbacks.setProgress(percent, progress.status || "Rust native finder running...");
            }
        );

        const rustCandidates = extractRustFinderCandidates(rustRawResults, selected.key, selected.name, baseParams);
        if (rustCandidates.length > 0) {
            for (const candidate of rustCandidates) {
                insertResult(candidate);
            }
            return finalizeRun(totalRuns, 1, "rust_native_finder", {
                pipeline: "rust_native",
                prescreenRuns: 0,
                fullRuns: totalRuns,
                shortlistRuns: rustCandidates.length,
                shortBars: closedData.length,
                shortCoverage: 1,
                rustCandidateCount: rustCandidates.length,
            });
        }

        debugLogger.warn("[Finder] Rust native finder returned no usable candidates. Falling back to batch pipeline.");
        if (!cacheId && cacheRequested) {
            callbacks.setStatus("Rust native finder fell back to batch mode; caching data...");
            cacheId = await rustEngine.cacheData(closedData);
        }
    }

    const useRandomFunnel =
        !requiresCompositeEdgeRatioSort &&
        !requiresTradeTimingQualitySort &&
        input.options.mode === "random" &&
        (
            (!useRustForFinder && totalRuns >= 220) ||
            (useRustForFinder && totalRuns >= 900 && flags.isLargeDataset)
        );

    if (useRandomFunnel) {
        const allJobs: ParamJob[] = [];
        while (allJobs.length < totalRuns) {
            const jobs = nextJobBatch(Math.max(flags.batchSize, 64));
            if (jobs.length === 0) break;
            allJobs.push(...jobs);
        }

        const shortData = selectPrescreenDataSlice(closedData);
        const shortCoverage = Math.min(1, shortData.length / Math.max(1, closedData.length));
        const quickMinTrades = input.options.tradeFilterEnabled
            ? Math.max(1, Math.floor(input.options.minTrades * shortCoverage * 0.35))
            : 0;
        const shortPrecomputeStartedAt = performance.now();
        const shortPrecomputed = precomputeIndicators(shortData, effectiveBacktestSettings);
        timing.indicatorPrecompute += performance.now() - shortPrecomputeStartedAt;
        const quickCandidates: QuickFunnelCandidate[] = [];
        const shortlistCount = resolveQuickFunnelShortlistCount(allJobs.length, input.options.topN, {
            rustStage: useRustForFinder,
        });
        const quickBacktestFn = runBacktestCompact;

        callbacks.setStatus(`Random funnel stage A/B: ${allJobs.length} quick checks...`);
        callbacks.setProgress(10, `Stage A/B on ${shortData.length} bars...`);

        for (let i = 0; i < allJobs.length; i++) {
            const job = allJobs[i];
            if (isCrossSymbolJobSkipped(job)) continue;
            const runStartedAt = performance.now();
            try {
                const jobData = getJobData(job, shortData);
                const tSignalStart = performance.now();
                let signals = generateSignalsForJob(
                    job,
                    jobData,
                    preparedDataCache,
                    effectiveBacktestSettings,
                    getJobCtx(job),
                    (signalTiming) => recordSignalTiming(job, signalTiming)
                );
                timing.signalGeneration += performance.now() - tSignalStart;
                signals = applyComboMerge(signals, input);

                const tQuickStart = performance.now();
                if (job.strategy.metadata?.role !== "entry" && signals.length === 0) {
                    signals.length = 0;
                    continue;
                }
                const quickRawResult = runStrategyBacktest({
                    strategy: job.strategy,
                    data: jobData,
                    signals,
                    params: job.params,
                    capitalSettings: effectiveCapitalSettings,
                    backtestSettings: resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                    backtestFn: quickBacktestFn,
                    precomputed: getJobPrecomputed(job, shortPrecomputed),
                    backtestOptions: { collectDiagnostics: true },
                });
                recordBacktestResult(job, quickRawResult);
                const quickBacktestMs = performance.now() - tQuickStart;
                timing.backtest += quickBacktestMs;
                recordBacktestTiming(job, quickBacktestMs);

                const quickResult = normalizeResultSharpe(quickRawResult);
                if (quickMinTrades > 0 && quickResult.totalTrades < quickMinTrades) {
                    signals.length = 0;
                    continue;
                }
                quickCandidates.push({ job, result: quickResult, comparable: buildComparableFinderResult(job.key, job.name, job.params, quickResult) });
                signals.length = 0;
            } catch (error) {
                recordFailure(job, error);
                debugLogger.warn(`[Finder] Random funnel prescreen failed for ${job.key}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            } finally {
                recordRunTiming(job, performance.now() - runStartedAt);
            }

            if ((i + 1) % 20 === 0 || i + 1 === allJobs.length) {
                const progress = 10 + ((i + 1) / Math.max(1, allJobs.length)) * 45;
                if (shouldUpdateUi(i + 1 === allJobs.length)) {
                    callbacks.setProgress(progress, `Stage A/B ${i + 1}/${allJobs.length}`);
                }
            }
            await measuredYield(i + 1 === allJobs.length);
        }

        const shortlistRankingStartedAt = performance.now();
        quickCandidates.sort((a, b) => compareFinderResults(
            a.comparable,
            b.comparable,
            input.options.sortPriority
        ));
        timing.resultRanking += performance.now() - shortlistRankingStartedAt;
        const shortlisted = quickCandidates.slice(0, shortlistCount);

        callbacks.setStatus(`Random funnel stage C: full backtest on ${shortlisted.length}/${allJobs.length} survivors...`);
        callbacks.setProgress(56, `Stage C ${shortlisted.length} survivors`);

        const backtestFn = usingCompactBacktest ? runBacktestCompact : runBacktest;
        if (!useRustForFinder) {
            const runBacktestFallback = createBacktestFallbackRunner({
                closedData,
                backtestFn,
                capitalSettings: effectiveCapitalSettings,
                resolveBacktestSettings: (job) => resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                getJobData,
                getJobPrecomputed,
                defaultPrecomputed: singleTfPrecomputed,
                insertResult,
                timing,
                onBacktestResult: recordBacktestResult,
                onFailure: recordFailure,
            });

            for (let i = 0; i < shortlisted.length; i++) {
                const { job } = shortlisted[i];
                if (isCrossSymbolJobSkipped(job)) continue;
                const runStartedAt = performance.now();
                try {
                    const jobData = getJobData(job, closedData);
                    const tSignalStart = performance.now();
                    let signals = generateSignalsForJob(
                        job,
                        jobData,
                        preparedDataCache,
                        effectiveBacktestSettings,
                        getJobCtx(job),
                        (signalTiming) => recordSignalTiming(job, signalTiming)
                    );
                    timing.signalGeneration += performance.now() - tSignalStart;
                    signals = applyComboMerge(signals, input);

                    const backtestStartedAt = performance.now();
                    runBacktestFallback({
                        id: `${job.key}-funnel-${job.id}`,
                        job,
                        signals,
                    });
                    recordBacktestTiming(job, performance.now() - backtestStartedAt);
                } catch (error) {
                    recordFailure(job, error);
                    debugLogger.warn(`[Finder] Random funnel full run failed for ${job.key}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                } finally {
                    recordRunTiming(job, performance.now() - runStartedAt);
                }

                processedCount = i + 1;
                if ((i + 1) % 10 === 0 || i + 1 === shortlisted.length) {
                    const progress = 56 + ((i + 1) / Math.max(1, shortlisted.length)) * 41;
                    if (shouldUpdateUi(i + 1 === shortlisted.length)) {
                        callbacks.setProgress(progress, `Stage C ${i + 1}/${shortlisted.length}`);
                        callbacks.setStatus(`Processing funnel survivors ${i + 1}/${shortlisted.length}...`);
                    }
                }
                await measuredYield(i + 1 === shortlisted.length);
            }

            return finalizeRun(allJobs.length, 1, "typescript_random_funnel", {
                pipeline: "ts_funnel",
                prescreenRuns: allJobs.length,
                fullRuns: shortlisted.length,
                shortlistRuns: shortlisted.length,
                shortBars: shortData.length,
                shortCoverage,
                rustCandidateCount: 0,
            });
        }

        const shortlistedJobs = shortlisted.map((candidate) => candidate.job);
        const funnelBatchSize = Math.max(1, Math.min(flags.batchSize, shortlistedJobs.length));
        const totalFunnelBatches = Math.ceil(shortlistedJobs.length / funnelBatchSize);

        const runBacktestFallback = createBacktestFallbackRunner({
            closedData,
            backtestFn,
            capitalSettings: effectiveCapitalSettings,
            resolveBacktestSettings: (job) => resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
            getJobData,
            getJobPrecomputed,
            defaultPrecomputed: singleTfPrecomputed,
            insertResult,
            timing,
            onBacktestResult: recordBacktestResult,
            onFailure: recordFailure,
        });

        for (let batchIndex = 0; batchIndex < totalFunnelBatches; batchIndex++) {
            const batchJobs = shortlistedJobs.slice(batchIndex * funnelBatchSize, (batchIndex + 1) * funnelBatchSize);
            const batchRuns = prepareRustBatchRuns({
                jobs: batchJobs,
                closedData,
                preparedDataCache,
                preparedSettings: effectiveBacktestSettings,
                input,
                getJobData,
                getJobCtx,
                isCrossSymbolJobSkipped,
                insertResult,
                timing,
                idForJob: (job) => `${job.key}-funnel-${job.id}`,
                mergeComboSignals: true,
                failureContext: "Random funnel signal generation",
                onSignalTiming: recordSignalTiming,
                onJobFailure: recordFailure,
            });

            const batchStartedAt = performance.now();
            const dispatchStats = await dispatchRustBatchWithFallback({
                batchRuns,
                closedData,
                cacheId,
                capitalSettings: effectiveCapitalSettings,
                rustSettings,
                rustCompactMode: flags.rustCompactMode,
                insertResult,
                runBacktestFallback,
                timing,
            });
            recordRustDispatchStats(dispatchStats);
            const avgBatchMs = (performance.now() - batchStartedAt) / Math.max(1, batchJobs.length);
            for (const job of batchJobs) {
                recordRunTiming(job, avgBatchMs);
            }

            processedCount += batchJobs.length;
            const isFinalBatch = batchIndex + 1 === totalFunnelBatches;
            if (shouldUpdateUi(isFinalBatch)) {
                const progress = 56 + (processedCount / Math.max(1, shortlistedJobs.length)) * 41;
                callbacks.setProgress(progress, `Stage C batch ${batchIndex + 1}/${totalFunnelBatches}`);
                callbacks.setStatus(`Processing funnel survivors ${processedCount}/${shortlistedJobs.length} with Rust...`);
            }
            await measuredYield(isFinalBatch);
        }

        return finalizeRun(allJobs.length, totalFunnelBatches, "rust_random_funnel", {
            pipeline: "rust_funnel",
            prescreenRuns: allJobs.length,
            fullRuns: shortlisted.length,
            shortlistRuns: shortlisted.length,
            shortBars: shortData.length,
            shortCoverage,
            rustCandidateCount: 0,
        });
    }

    const totalBatches = Math.ceil(totalRuns / flags.batchSize);
    let batchNum = 0;
    const backtestFn = usingCompactBacktest ? runBacktestCompact : runBacktest;
    const tsRunBacktestFallback = createBacktestFallbackRunner({
        closedData,
        backtestFn,
        capitalSettings: effectiveCapitalSettings,
        resolveBacktestSettings: (job) => resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
        getJobData,
        getJobPrecomputed,
        defaultPrecomputed: singleTfPrecomputed,
        insertResult,
        timing,
        onBacktestResult: recordBacktestResult,
        onFailure: recordFailure,
    });
    const rustRunBacktestFallback = createBacktestFallbackRunner({
        closedData,
        backtestFn,
        capitalSettings,
        resolveBacktestSettings: (job) => job.backtestSettings,
        getJobData,
        getJobPrecomputed,
        defaultPrecomputed: singleTfPrecomputed,
        insertResult,
        timing,
        onBacktestResult: recordBacktestResult,
        onFailure: recordFailure,
    });

    while (processedCount < totalRuns) {
        if (callbacks.isCancelled()) {
            callbacks.setStatus("Finder stopped by user.");
            const trimmed = ranker.toSortedArray(input.options.topN);
            measuredResultsUpdate(trimmed);
            return { results: trimmed };
        }

        const batchJobs = nextJobBatch(flags.batchSize);
        if (batchJobs.length === 0) break;
        batchNum++;

        if (!useRustForFinder) {
            for (const job of batchJobs) {
                if (isCrossSymbolJobSkipped(job)) continue;
                const runStartedAt = performance.now();
                try {
                    const jobData = getJobData(job, closedData);
                    const tSignalStart = performance.now();
                    const signals = generateSignalsForJob(
                        job,
                        jobData,
                        preparedDataCache,
                        effectiveBacktestSettings,
                        getJobCtx(job),
                        (signalTiming) => recordSignalTiming(job, signalTiming)
                    );
                    timing.signalGeneration += performance.now() - tSignalStart;

                    const backtestStartedAt = performance.now();
                    tsRunBacktestFallback({
                        id: `${job.key}-${job.id}`,
                        job,
                        signals: applyComboMerge(signals, input),
                    });
                    recordBacktestTiming(job, performance.now() - backtestStartedAt);
                } catch (error) {
                    recordFailure(job, error);
                    debugLogger.warn(`[Finder] Backtest failed for ${job.key}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                } finally {
                    recordRunTiming(job, performance.now() - runStartedAt);
                }

                await measuredYield(false);
            }

        processedCount += batchJobs.length;
        if (shouldUpdateUi(processedCount === totalRuns)) {
            const progress = 10 + (processedCount / totalRuns) * 85;
            callbacks.setProgress(progress, `Batch ${batchNum}/${totalBatches} (${processedCount}/${totalRuns})`);
            if (flags.isExtremeDataset) {
                callbacks.setStatus(`Processing ${batchNum}/${totalBatches} (ultra-memory mode)...`);
            } else {
                callbacks.setStatus(`Processing batch ${batchNum}/${totalBatches}...`);
            }
            const resultsNow = performance.now();
            if (resultsNow - lastResultsUpdateAt > 750 || processedCount === totalRuns) {
                lastResultsUpdateAt = resultsNow;
                measuredResultsUpdate(ranker.toSortedArray(input.options.topN));
            }
        }
        await measuredYield(true);
            continue;
        }

        const batchRuns = prepareRustBatchRuns({
            jobs: batchJobs,
            closedData,
            preparedDataCache,
            preparedSettings: effectiveBacktestSettings,
            input,
            getJobData,
            getJobCtx,
            isCrossSymbolJobSkipped,
            insertResult,
            timing,
            idForJob: (job) => `${job.key}-${job.id}`,
            mergeComboSignals: false,
            failureContext: "Signal generation",
            onSignalTiming: recordSignalTiming,
            onJobFailure: recordFailure,
        });

        if (batchRuns.length === 0) {
            processedCount += batchJobs.length;
            continue;
        }

        const batchStartedAt = performance.now();
        const dispatchStats = await dispatchRustBatchWithFallback({
            batchRuns,
            closedData,
            cacheId,
            capitalSettings,
            rustSettings,
            rustCompactMode: flags.rustCompactMode,
            insertResult,
            runBacktestFallback: rustRunBacktestFallback,
            timing,
            onUnknownRunId: (id) => {
                debugLogger.warn("[Finder] Rust batch returned unknown run id", { id });
            },
            onInconsistentResult: (run) => {
                recordFailure(run.job, "inconsistent Rust batch result");
                debugLogger.warn(`[Finder] Rust batch result inconsistent for ${run.job.key}, using TypeScript fallback.`);
            },
        });
        recordRustDispatchStats(dispatchStats);
        const avgBatchMs = (performance.now() - batchStartedAt) / Math.max(1, batchJobs.length);
        for (const job of batchJobs) {
            recordRunTiming(job, avgBatchMs);
        }

        processedCount += batchJobs.length;
        if (shouldUpdateUi(processedCount === totalRuns)) {
            const progress = 10 + (processedCount / totalRuns) * 85;
            callbacks.setProgress(progress, `Batch ${batchNum}/${totalBatches} (${processedCount}/${totalRuns})`);
            if (flags.isExtremeDataset) {
                callbacks.setStatus(`Processing ${batchNum}/${totalBatches} (ultra-memory mode)...`);
            } else {
                callbacks.setStatus(`Processing batch ${batchNum}/${totalBatches}...`);
            }
            const resultsNow = performance.now();
            if (resultsNow - lastResultsUpdateAt > 750 || processedCount === totalRuns) {
                lastResultsUpdateAt = resultsNow;
                measuredResultsUpdate(ranker.toSortedArray(input.options.topN));
            }
        }
        await measuredYield(true);
    }

    return finalizeRun(
        processedCount,
        totalBatches,
        useRustForFinder ? (cacheId ? "rust_cached" : "rust_direct") : "typescript",
        {
            pipeline: "standard",
            prescreenRuns: 0,
            fullRuns: processedCount,
            shortlistRuns: processedCount,
            shortBars: closedData.length,
            shortCoverage: 1,
            rustCandidateCount: 0,
        }
    );
}

async function reconcileSingleTimeframeTopResults(
    candidates: FinderResult[],
    input: FinderRunInput,
    closedData: OHLCVData[],
    capitalSettings: CapitalSettings,
    maybeYieldByBudget: (force?: boolean) => Promise<void>,
    existingPrecomputed?: ReturnType<typeof precomputeIndicators>,
    existingPreparedDataCache?: FinderPreparedDataCache,
    crossSymbolContextMap?: Map<string, {
        data: OHLCVData[];
        ctx: StrategyExecutionContext | undefined;
        precomputed: ReturnType<typeof precomputeIndicators>;
    }>
): Promise<FinderResult[]> {
    const { initialCapital } = capitalSettings;
    const strategyByKey = new Map(input.selectedStrategies.map((item) => [item.key, item.strategy]));
    const requiresCompositeEdgeRatioSort = finderSortRequiresCompositeEdgeRatio(input.options.sortPriority);
    const requiresTradeTimingQualitySort = finderSortRequiresTradeTimingQuality(input.options.sortPriority);
    const lastDataTime = closedData.length > 0 ? closedData[closedData.length - 1].time : null;
    const rustSettings = sanitizeBacktestSettingsForRust(input.settings);
    const comboActive = Boolean(input.comboPrimarySignals);
    const comboBacktestSettings = input.comboPrimarySettings ?? input.settings;
    const precomputed = existingPrecomputed ?? precomputeIndicators(closedData, comboBacktestSettings);
    const preparedDataCache = existingPreparedDataCache ?? new WeakMap();
    const reconciled: FinderResult[] = [];

    for (const candidate of candidates) {
        const strategy = strategyByKey.get(candidate.key);
        if (!strategy) {
            reconciled.push(candidate);
            continue;
        }

        try {
            const csEntry = crossSymbolContextMap?.get(candidate.key);
            const jobData = csEntry?.data ?? closedData;
            const jobCtx = csEntry?.ctx;
            const jobPrecomputed = csEntry?.precomputed ?? precomputed;
            const normalizedParams = normalizeFinderCandidateParams(strategy, candidate.params);
            const { backtestSettings } = resolveFinderRiskOverrides(input.settings, rustSettings, normalizedParams, input.options);
            const preparedFinderData = getPreparedFinderData(
                preparedDataCache,
                candidate.key,
                strategy,
                jobData,
                comboBacktestSettings,
                jobCtx
            );
            const rawSignals = strategy.executePrepared
                ? strategy.executePrepared(preparedFinderData, normalizedParams, jobData, jobCtx)
                : strategy.execute(jobData, normalizedParams, jobCtx);
            const signals = applyConfirmationStrategiesToSignals({
                data: jobData,
                baseSignals: applySignalPolarity(rawSignals, backtestSettings),
                settings: backtestSettings,
            });
            const mergedSignals = comboActive ? applyComboMerge(signals, input) : signals;
            const rawResult = runStrategyBacktest({
                strategy,
                data: jobData,
                signals: mergedSignals,
                params: normalizedParams,
                capitalSettings,
                backtestSettings: resolveFinderCandidateBacktestSettings(backtestSettings, input.comboPrimarySettings),
                backtestFn: runBacktest,
                precomputed: jobPrecomputed,
            });
            reconciled.push(enrichFinderCandidate({
                candidate: {
                    ...candidate,
                    params: normalizedParams,
                    result: rawResult,
                },
                candidateData: jobData,
                lastDataTime,
                initialCapital,
                requiresCompositeEdgeRatioSort,
                requiresTradeTimingQualitySort,
            }));
        } catch (_error) {
            reconciled.push(candidate);
        }

        await maybeYieldByBudget(false);
    }

    return reconciled
        .sort((a, b) => compareFinderResults(a, b, input.options.sortPriority))
        .slice(0, Math.max(1, input.options.topN));
}
