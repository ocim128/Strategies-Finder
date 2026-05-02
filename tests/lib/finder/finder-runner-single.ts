import {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
    buildEntryBacktestResult,
    precomputeIndicators,
    runBacktest,
    runBacktestCompact,
    applySignalPolarity,
} from "../strategies/index";
import type { StrategyExecutionContext } from "../types/strategies";
import { rustEngine } from "../rust-engine-client";
import { shouldUseRustEngine } from "../engine-preferences";
import { debugLogger } from "../debug-logger";
import { strategies as builtInStrategies } from "../strategies/library";
import { isCrossSymbolStrategy, resolveCrossSymbolExecution } from "../cross-symbol-runtime";

import { calculateSharpeRatioFromEquityCurve, calculateSharpeRatioFromReturns } from "../strategies/performance-metrics";
import { buildSelectionResult } from "./endpoint";
import { aggregateFinderBacktestResults, compareFinderResults } from "./finder-engine";
import { FinderResultRanker } from "./finder-result-ranker";
import { hasNonZeroSnapshotFilter, sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import type { FinderDataset } from "./finder-timeframe-loader";
import type { EndpointSelectionAdjustment, FinderOptions, FinderRandomBenchmark, FinderResult } from "../types/finder";
import type { CapitalSettings } from "../types/backtest";
import { trimToClosedCandles } from "../closed-candle-utils";
import { selectExecutionAwareClosedCandles } from "../alert-evaluation-window";
import { mergeStrategySignals } from "../signal-merge";
import { runGeneticOptimization } from "./genetic-optimizer";
import {
    attachTradeTimingQuality,
    finderSortRequiresTradeTimingQuality,
} from "../trade-timing-quality";
import {
    buildFinderSearchBaseParams,
    buildComparableFinderResult,
    compactSignalsForRust,
    computeFinderCompositeEdgeRatio,
    computeAverageCompositeEdgeRatio,
    extractRustFinderCandidates,
    finderSortRequiresCompositeEdgeRatio,
    getPreparedFinderData,
    normalizeFinderCandidateParams,
    normalizeFinderCandidateParamSets,
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
import { buildFinderResult, runStrategyBacktest } from "./finder-runner-shared";

export { resolveFinderCandidateBacktestSettings, shouldUseRustCachedMode } from "./finder-runner-core";

let dataManagerModulePromise: Promise<typeof import("../data-manager")> | null = null;

async function getDataManager() {
    dataManagerModulePromise ??= import("../data-manager");
    return (await dataManagerModulePromise).dataManager;
}

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

export interface FinderSelectedStrategy {
    key: string;
    name: string;
    strategy: Strategy;
}

export interface FinderRunInput {
    ohlcvData: OHLCVData[];
    symbol: string;
    interval: string;
    options: FinderOptions;
    settings: BacktestSettings;
    requiresTsEngine: boolean;
    selectedStrategies: FinderSelectedStrategy[];
    capitalSettings: CapitalSettings;
    getFinderTimeframesForRun: (options: FinderOptions) => string[];
    loadMultiTimeframeDatasets: (symbol: string, intervals: string[]) => Promise<FinderDataset[]>;
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    buildRandomConfirmationParams: (strategyKeys: string[], options: FinderOptions) => Record<string, StrategyParams>;
    /** Combo Finder: cached primary signals (generated once from locked primary config). */
    comboPrimarySignals?: Signal[];
    /** Combo Finder: primary config's resolved backtest settings for the merged run. */
    comboPrimarySettings?: BacktestSettings;
    /** Combo Finder: primary config's capital settings for the merged run. */
    comboPrimaryCapital?: CapitalSettings;
}

export interface FinderRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    onResultsUpdate: (results: FinderResult[]) => void;
}

export interface FinderRunOutput {
    results: FinderResult[];
    randomBenchmark?: FinderRandomBenchmark;
}

type StrategyPlan = {
    key: string;
    name: string;
    strategy: Strategy;
    paramSets: StrategyParams[];
};

type ParamJob = {
    id: number;
    key: string;
    name: string;
    params: StrategyParams;
    backtestSettings: BacktestSettings;
    rustBacktestSettings: BacktestSettings;
    strategy: Strategy;
};

type FinderDatasetFlags = {
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

type PreparedRun = {
    id: string;
    job: ParamJob;
    signals: Signal[];
};

export async function runFinderExecution(input: FinderRunInput, callbacks: FinderRunCallbacks): Promise<FinderRunOutput> {
    const {
        options,
        settings,
        selectedStrategies,
        capitalSettings,
    } = input;

    const rustSettings = sanitizeBacktestSettingsForRust(settings);
    const runTimeframes = input.getFinderTimeframesForRun(options);
    const usingMultiTimeframe = options.multiTimeframeEnabled === true;

    if (usingMultiTimeframe) {
        const crossSymbolStrategies = selectedStrategies.filter(s => isCrossSymbolStrategy(s.strategy));
        if (crossSymbolStrategies.length > 0) {
            const names = crossSymbolStrategies.map(s => s.name).join(', ');
            callbacks.setStatus(`Cross-symbol strategies (${names}) are not supported with multi-timeframe Finder.`);
            callbacks.setProgress(100, 'Unsupported configuration');
            return { results: [] };
        }
    }

    const flags = computeDatasetFlags(input.ohlcvData.length, settings, options, false);
    if (flags.isExtremeDataset) {
        debugLogger.warn(`[Finder] EXTREME dataset detected (${flags.dataSize} bars). Using ultra-memory-efficient mode.`);
        callbacks.setStatus(`Ultra-memory mode: ${(flags.dataSize / 1_000_000).toFixed(1)}M bars`);
    } else if (flags.isVeryLargeDataset) {
        debugLogger.warn(`[Finder] Very large dataset detected (${flags.dataSize} bars). Using memory-efficient mode.`);
    }

    if (options.mode === "genetic") {
        return runGeneticFinder({
            input,
            callbacks,
            flags,
            runTimeframes,
            capitalSettings,
        });
    }

    callbacks.setProgress(5, "Preparing parameter combinations...");

    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    for (const selection of selectedStrategies) {
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = normalizeFinderCandidateParamSets(
            selection.strategy,
            input.generateParamSets(extendedDefaults, options)
        );
        if (paramSets.length === 0) continue;
        totalRuns += paramSets.length;
        strategyPlans.push({
            key: selection.key,
            name: selection.name,
            strategy: selection.strategy,
            paramSets,
        });
    }

    if (totalRuns === 0) {
        callbacks.setStatus("No valid parameter combinations generated.");
        return { results: [] };
    }

    let planIndex = 0;
    let paramIndex = 0;
    let nextJobId = 0;
    const nextJobBatch = (batchSize: number): ParamJob[] => {
        const batch: ParamJob[] = [];
        while (batch.length < batchSize && planIndex < strategyPlans.length) {
            const plan = strategyPlans[planIndex];
            if (paramIndex >= plan.paramSets.length) {
                planIndex++;
                paramIndex = 0;
                continue;
            }

            const params = plan.paramSets[paramIndex++];
            const { backtestSettings, rustBacktestSettings } = resolveFinderRiskOverrides(settings, rustSettings, params, options);

            batch.push({
                id: nextJobId++,
                key: plan.key,
                name: plan.name,
                params,
                backtestSettings,
                rustBacktestSettings,
                strategy: plan.strategy,
            });
        }
        return batch;
    };

    let lastUiUpdateAt = 0;
    const shouldUpdateUi = (force = false): boolean => {
        const now = performance.now();
        if (!force && (now - lastUiUpdateAt) < 250) return false;
        lastUiUpdateAt = now;
        return true;
    };

    const yieldBudgetMs = flags.isHeavyFinderConfig ? 32 : 50;
    let sliceStart = performance.now();
    const maybeYieldByBudget = async (force = false): Promise<void> => {
        const now = performance.now();
        if (!force && (now - sliceStart) < yieldBudgetMs) return;
        await callbacks.yieldControl();
        sliceStart = performance.now();
    };

    if (usingMultiTimeframe) {
        return runMultiTimeframe({
            input,
            callbacks,
            flags,
            totalRuns,
            nextJobBatch,
            shouldUpdateUi,
            maybeYieldByBudget,
            capitalSettings,
            runTimeframes,
        });
    }

    return runSingleTimeframe({
        input,
        callbacks,
        flags,
        totalRuns,
        nextJobBatch,
        shouldUpdateUi,
        maybeYieldByBudget,
        capitalSettings,
        rustSettings,
    });
}

interface MultiTimeframeRunParams {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    flags: FinderDatasetFlags;
    totalRuns: number;
    nextJobBatch: (batchSize: number) => ParamJob[];
    shouldUpdateUi: (force?: boolean) => boolean;
    maybeYieldByBudget: (force?: boolean) => Promise<void>;
    capitalSettings: CapitalSettings;
    runTimeframes: string[];
}

function resolveEffectiveCapitalSettings(input: FinderRunInput): CapitalSettings {
    return input.comboPrimaryCapital ?? input.capitalSettings;
}

async function runMultiTimeframe(params: MultiTimeframeRunParams): Promise<FinderRunOutput> {
    const {
        input,
        callbacks,
        flags,
        totalRuns,
        nextJobBatch,
        shouldUpdateUi,
        maybeYieldByBudget,
        runTimeframes,
    } = params;
    const effectiveCapitalSettings = resolveEffectiveCapitalSettings(input);
    const {
        initialCapital: effectiveInitialCapital,
    } = effectiveCapitalSettings;
    const effectiveBacktestSettings = input.comboPrimarySettings ?? input.settings;

    callbacks.setProgress(8, `Loading ${runTimeframes.length} timeframe datasets...`);
    callbacks.setStatus(`Loading timeframe datasets (${runTimeframes.length})...`);
    const datasets = await input.loadMultiTimeframeDatasets(input.symbol, runTimeframes);
    const activeDatasets = datasets
        .map((dataset) => ({
            ...dataset,
            data: buildFinderEvaluationData(dataset.data, dataset.interval, effectiveBacktestSettings),
        }))
        .filter((dataset) => dataset.data.length > 0);

    if (activeDatasets.length === 0) {
        callbacks.setStatus("No data available for selected timeframes.");
        return { results: [] };
    }

    callbacks.setProgress(12, `Running ${totalRuns} runs across ${activeDatasets.length} timeframes...`);

    const precomputedByInterval = new Map<string, ReturnType<typeof precomputeIndicators>>();
    for (const dataset of activeDatasets) {
        precomputedByInterval.set(dataset.interval, precomputeIndicators(dataset.data, effectiveBacktestSettings));
    }

    // Combo mode: pre-generate primary signals per timeframe
    const comboPrimarySignalsByInterval = new Map<string, Signal[]>();
    if (input.comboPrimarySignals) {
        // For multi-timeframe combo, we need primary signals from each TF's data.
        // The primary strategy must be re-executed per timeframe.
        const { loadBuiltInStrategyByKey, strategyRegistry } = await import('../../strategyRegistry');
        const { settingsManager } = await import('../settings-manager');
        const { resolveBacktestSettingsFromRaw } = await import('../backtest-settings-resolver');
        const primaryConfigName = input.options.comboPrimaryConfigName;
        if (primaryConfigName) {
            const primaryConfig = settingsManager.loadStrategyConfig(primaryConfigName);
            if (primaryConfig) {
                const primaryStrategy = strategyRegistry.get(primaryConfig.strategyKey)
                    ?? await loadBuiltInStrategyByKey(primaryConfig.strategyKey);
                if (primaryStrategy) {
                    const primarySettings = resolveBacktestSettingsFromRaw(
                        primaryConfig.backtestSettings,
                        { coerceWithoutUiToggles: true }
                    );
                    for (const dataset of activeDatasets) {
                        const primarySigs = applySignalPolarity(
                            primaryStrategy.execute(dataset.data, primaryConfig.strategyParams),
                            primarySettings
                        );
                        comboPrimarySignalsByInterval.set(dataset.interval, primarySigs);
                    }
                }
            }
        }
    }


    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const requiresCompositeEdgeRatioSort = finderSortRequiresCompositeEdgeRatio(input.options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
    const timeframeLabels = activeDatasets.map((dataset) => dataset.interval);

    while (processedCount < totalRuns) {
        if (callbacks.isCancelled()) {
            callbacks.setStatus("Finder stopped by user.");
            const trimmed = ranker.toSortedArray(input.options.topN);
            callbacks.onResultsUpdate(trimmed);
            return { results: trimmed };
        }

        const batchJobs = nextJobBatch(flags.batchSize);
        if (batchJobs.length === 0) break;

        for (const job of batchJobs) {
            const timeframeResults: Array<{ result: BacktestResult; data: OHLCVData[] }> = [];
            for (const dataset of activeDatasets) {
                try {
                    let signals = generateSignalsForJob(
                        job,
                        dataset.data,
                        preparedDataCache,
                        effectiveBacktestSettings
                    );
                    // Combo mode: AND-merge with primary signals for this timeframe
                    const tfPrimarySignals = comboPrimarySignalsByInterval.get(dataset.interval);
                    if (tfPrimarySignals) {
                        signals = mergeStrategySignals(tfPrimarySignals, signals, 'and') as Signal[];
                    }
                    const datasetUseCompact = !requiresCompositeEdgeRatioSort && dataset.data.length >= flags.compactBacktestThreshold;
                    const timeframeBacktestFn = datasetUseCompact ? runBacktestCompact : runBacktest;
                    const result = runStrategyBacktest({
                        strategy: job.strategy,
                        data: dataset.data,
                        signals,
                        params: job.params,
                        capitalSettings: effectiveCapitalSettings,
                        backtestSettings: resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                        backtestFn: timeframeBacktestFn,
                        precomputed: precomputedByInterval.get(dataset.interval),
                    });

                    timeframeResults.push({ result, data: dataset.data });
                    signals.length = 0;
                } catch (error) {
                    debugLogger.warn(`[Finder] Multi timeframe run failed for ${job.key} @ ${dataset.interval}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            if (timeframeResults.length > 0) {
                const aggregatedResult = aggregateFinderBacktestResults(
                    timeframeResults.map((entry) => entry.result),
                    effectiveInitialCapital
                );
                if (input.options.tradeFilterEnabled && aggregatedResult.totalTrades < input.options.minTrades) {
                    processedCount++;
                    await maybeYieldByBudget(processedCount === totalRuns);
                    continue;
                }

                const lastDataTime = activeDatasets.length === 1
                    ? activeDatasets[0].data[activeDatasets[0].data.length - 1]?.time ?? null
                    : null;
                const adjustment = buildSelectionResult(aggregatedResult, lastDataTime, effectiveInitialCapital);
                const enriched: FinderResult = buildFinderResult({
                    key: job.key,
                    name: job.name,
                    comboMode: Boolean(input.comboPrimarySignals),
                    comboPrimaryConfigName: input.options.comboPrimaryConfigName,
                    timeframes: timeframeLabels,
                    params: job.params,
                    result: aggregatedResult,
                    selectionResult: adjustment.result,
                    compositeEdgeRatio: requiresCompositeEdgeRatioSort
                        ? computeAverageCompositeEdgeRatio(timeframeResults)
                        : undefined,
                    endpointAdjusted: adjustment.adjusted,
                    endpointRemovedTrades: adjustment.removedTrades,
                });

                if (!input.options.tradeFilterEnabled ||
                    (enriched.result.totalTrades >= input.options.minTrades &&
                        enriched.result.totalTrades <= input.options.maxTrades)) {
                    filteredCount++;
                    if (enriched.endpointAdjusted) {
                        endpointAdjustedCount++;
                    }
                    ranker.offer(enriched);
                }
            }

            processedCount++;
            if (processedCount % 16 === 0 || processedCount === totalRuns) {
                const updateUi = shouldUpdateUi(processedCount === totalRuns);
                if (updateUi) {
                    const progress = 12 + (processedCount / totalRuns) * 84;
                    callbacks.setProgress(progress, `${processedCount}/${totalRuns} runs (${activeDatasets.length} TF)`);
                    callbacks.setStatus(`Processing ${processedCount}/${totalRuns} runs across ${activeDatasets.length} timeframes...`);
                    callbacks.onResultsUpdate(ranker.toSortedArray(input.options.topN));
                }
            }
            await maybeYieldByBudget(processedCount === totalRuns);
        }
    }

    const trimmed = ranker.toSortedArray(input.options.topN);
    const statusParts = [
        `${processedCount} runs`,
        `${activeDatasets.length} timeframes`,
    ];
    if (input.options.tradeFilterEnabled) {
        statusParts.push(`${filteredCount} matched`);
    }
    if (endpointAdjustedCount > 0) {
        statusParts.push(`${endpointAdjustedCount} endpoint-adjusted`);
    }
    statusParts.push(`${trimmed.length} shown`);

    callbacks.setProgress(100, `${totalRuns}/${totalRuns} runs`);
    callbacks.setStatus(`Complete. ${statusParts.join(", ")}.`);
    return { results: trimmed };
}

interface GeneticFinderRunParams {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    flags: FinderDatasetFlags;
    runTimeframes: string[];
    capitalSettings: CapitalSettings;
}

async function runGeneticFinder(params: GeneticFinderRunParams): Promise<FinderRunOutput> {
    const { input, callbacks, capitalSettings } = params;
    const { initialCapital } = capitalSettings;

    if (input.options.multiTimeframeEnabled) {
        callbacks.setStatus("Genetic search is currently single-timeframe only.");
        return { results: [] };
    }

    if (input.comboPrimarySignals) {
        callbacks.setStatus("Genetic search is currently unavailable in combo mode.");
        return { results: [] };
    }

    const closedData = trimToClosedCandles(input.ohlcvData, input.interval);
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for genetic finder run.");
        return { results: [] };
    }

    const lastDataTime = closedData[closedData.length - 1]?.time ?? null;
    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    let filteredCount = 0;
    let endpointAdjustedCount = 0;

    const populationSize = Math.max(16, Math.min(48, Math.round(Math.sqrt(Math.max(1, input.options.maxRuns)) * 4)));
    const generations = Math.max(2, Math.floor(Math.max(1, input.options.maxRuns) / populationSize));

    for (let index = 0; index < input.selectedStrategies.length; index++) {
        const selection = input.selectedStrategies[index];
        const progressBase = (index / Math.max(1, input.selectedStrategies.length)) * 90;
        callbacks.setProgress(progressBase, `Genetic ${selection.name}: preparing...`);

        // Resolve cross-symbol context for this strategy
        let geneticData = closedData;
        let geneticCtx: StrategyExecutionContext | undefined;
        if (isCrossSymbolStrategy(selection.strategy)) {
            try {
                const dataManager = await getDataManager();
                const resolved = await resolveCrossSymbolExecution({
                    strategy: selection.strategy,
                    primarySymbol: input.symbol,
                    interval: input.interval,
                    primaryData: closedData,
                    settings: input.settings,
                    dataFetcher: dataManager,
                });
                geneticData = resolved.primaryData;
                geneticCtx = resolved.context;
            } catch (error) {
                debugLogger.warn(`[Finder] Genetic cross-symbol resolution failed for ${selection.key}`, error);
                continue;
            }
        }

        let optimization;
        try {
            optimization = await runGeneticOptimization({
                strategyKey: selection.key,
                strategy: selection.strategy,
                data: geneticData,
                backtestSettings: input.settings,
                executionContext: geneticCtx,
                config: {
                    populationSize,
                    generations,
                    eliteCount: Math.max(1, Math.floor(populationSize * 0.15)),
                    mutationRate: 0.2,
                    mutationSigma: 0.18,
                    rangePercent: input.options.rangePercent,
                    seed: deriveStrategySeed(1337, selection.key),
                    tournamentSize: 4,
                    adaptiveMutation: {
                        enabled: true,
                        stagnationGenerations: 2,
                        increaseFactor: 1.3,
                        decayFactor: 0.92,
                        minRate: 0.08,
                        maxRate: 0.45,
                    },
                    backtest: {
                        ...capitalSettings,
                        minTrades: input.options.tradeFilterEnabled ? input.options.minTrades : 0,
                    },
                },
                onGeneration: (stats) => {
                    const perStrategyProgress = ((stats.generation + 1) / Math.max(1, generations)) * (90 / Math.max(1, input.selectedStrategies.length));
                    callbacks.setProgress(
                        Math.min(95, progressBase + perStrategyProgress),
                        `Genetic ${selection.name}: gen ${stats.generation + 1}/${generations}`
                    );
                    callbacks.setStatus(
                        `Genetic ${selection.name}: best ${stats.bestNetProfitPercent.toFixed(2)}%, Sharpe ${stats.bestSharpeRatio.toFixed(2)}, DD ${stats.bestDrawdownPercent.toFixed(2)}%`
                    );
                },
            });
        } catch (error) {
            debugLogger.warn(`[Finder] Genetic optimization skipped for ${selection.key}`, error);
            continue;
        }

        const normalizedResult = normalizeResultSharpe(optimization.bestGenome.result, initialCapital);
        const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);
        const candidate: FinderResult = buildFinderResult({
            key: selection.key,
            name: selection.name,
            params: normalizeFinderCandidateParams(selection.strategy, optimization.bestGenome.params),
            result: normalizedResult,
            selectionResult: adjustment.result,
            compositeEdgeRatio: finderSortRequiresCompositeEdgeRatio(input.options.sortPriority)
                ? computeFinderCompositeEdgeRatio(normalizedResult, closedData)
                : undefined,
            endpointAdjusted: adjustment.adjusted,
            endpointRemovedTrades: adjustment.removedTrades,
        });

        if (input.options.tradeFilterEnabled) {
            if (candidate.result.totalTrades < input.options.minTrades || candidate.result.totalTrades > input.options.maxTrades) {
                continue;
            }
        }

        filteredCount++;
        if (candidate.endpointAdjusted) {
            endpointAdjustedCount++;
        }
        ranker.offer(candidate);
        await callbacks.yieldControl();
    }

    const results = ranker.toSortedArray(input.options.topN);
    callbacks.setProgress(100, "Genetic search complete");
    callbacks.setStatus(`Complete. ${input.selectedStrategies.length} strategies searched, ${filteredCount} matched, ${endpointAdjustedCount} endpoint-adjusted, ${results.length} shown.`);
    return { results };
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
}

type FinderEngineDecision = {
    useRustForFinder: boolean;
    useRustCached: boolean;
    canTryNativeFinder: boolean;
    cacheId: string | null;
    statusMessage: string;
    cacheRequested: boolean;
};

type FinderTiming = {
    signalGeneration: number;
    rustBatchRequest: number;
    tsFallback: number;
    resultInsertion: number;
    total: number;
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
    timing: FinderTiming;
    onUnknownRunId?: (id: string) => void;
    onInconsistentResult?: (run: PreparedRun) => void;
};

/**
 * Shared helper to generate signals for a job.
 * Extracted to eliminate duplication between TS and Rust branches.
 */
function generateSignalsForJob(
    job: ParamJob,
    data: OHLCVData[],
    preparedDataCache?: FinderPreparedDataCache,
    preparedSettings?: BacktestSettings,
    executionContext?: import("../types/strategies").StrategyExecutionContext
): Signal[] {
    const preparedFinderData = preparedDataCache
        ? getPreparedFinderData(preparedDataCache, job.key, job.strategy, data, preparedSettings ?? job.backtestSettings, executionContext)
        : undefined;
    const rawSignals = job.strategy.executePrepared
        ? job.strategy.executePrepared(preparedFinderData, job.params, data, executionContext)
        : job.strategy.execute(data, job.params, executionContext);
    return applySignalPolarity(rawSignals, job.backtestSettings);
}

/**
 * In combo mode, AND-merges secondary signals with primarySignals.
 * In normal mode, returns signals unchanged.
 */
function applyComboMerge(
    signals: Signal[],
    input: FinderRunInput
): Signal[] {
    if (!input.comboPrimarySignals) return signals;
    return mergeStrategySignals(input.comboPrimarySignals, signals, 'and') as Signal[];
}


/**
 * Shared helper to run backtest and insert result.
 * Eliminates duplication between TS fallback paths.
 */
function runBacktestAndInsert(
    data: OHLCVData[],
    signals: Signal[],
    job: ParamJob,
    backtestFn: typeof runBacktest,
    capitalSettings: CapitalSettings,
    backtestSettings: BacktestSettings,
    precomputed: ReturnType<typeof precomputeIndicators>,
    insertResult: (candidate: CandidateResult) => void,
    onInsertTiming?: (durationMs: number) => void
): void {
    try {
        const result = runStrategyBacktest({
            strategy: job.strategy,
            data,
            signals,
            params: job.params,
            capitalSettings,
            backtestSettings,
            backtestFn,
            precomputed,
        });
        const insertStartedAt = performance.now();
        insertResult({
            key: job.key,
            name: job.name,
            params: job.params,
            result,
        });
        onInsertTiming?.(performance.now() - insertStartedAt);
    } catch (error) {
        debugLogger.warn(`[Finder] Backtest failed for ${job.key}`, {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

async function dispatchRustBatchWithFallback(args: RustBatchDispatchArgs): Promise<void> {
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
    if (batchRuns.length === 0) {
        return;
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
            const completedRunIds = new Set<string>();

            for (const batchEntry of batchResult.results) {
                const run = runById.get(batchEntry.id);
                if (!run) {
                    onUnknownRunId?.(batchEntry.id);
                    continue;
                }

                if (!isBacktestResultConsistent(batchEntry.result)) {
                    onInconsistentResult?.(run);
                    runBacktestFallback(run);
                    continue;
                }

                const tInsertStart = performance.now();
                insertResult({
                    key: run.job.key,
                    name: run.job.name,
                    params: run.job.params,
                    result: batchEntry.result,
                });
                timing.resultInsertion += performance.now() - tInsertStart;
                completedRunIds.add(run.id);
            }

            if (completedRunIds.size < batchRuns.length) {
                for (const run of batchRuns) {
                    if (!completedRunIds.has(run.id)) {
                        runBacktestFallback(run);
                    }
                }
            }
        } else {
            for (const run of batchRuns) {
                runBacktestFallback(run);
            }
        }
    } catch (_error) {
        for (const run of batchRuns) {
            runBacktestFallback(run);
        }
    } finally {
        timing.rustBatchRequest += performance.now() - tRustStart;
        for (const run of batchRuns) {
            run.signals.length = 0;
        }
        batchRuns.length = 0;
    }
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
        !comboActive &&
        input.options.mode === "random" &&
        !input.options.multiTimeframeEnabled &&
        rustHealthy &&
        input.selectedStrategies.length === 1 &&
        Object.prototype.hasOwnProperty.call(builtInStrategies, input.selectedStrategies[0]?.key ?? "");

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
    } = params;
    const effectiveCapitalSettings = resolveEffectiveCapitalSettings(input);
    const {
        initialCapital: effectiveInitialCapital,
    } = effectiveCapitalSettings;
    const effectiveBacktestSettings = input.comboPrimarySettings ?? input.settings;

    // Timing instrumentation for finder run
    const timing = {
        signalGeneration: 0,
        rustBatchRequest: 0,
        tsFallback: 0,
        resultInsertion: 0,
        total: 0,
    };
    const runStart = performance.now();

    const closedData = buildFinderEvaluationData(input.ohlcvData, input.interval, effectiveBacktestSettings);
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for finder run.");
        return { results: [] };
    }
    const singleTfPrecomputed = precomputeIndicators(closedData, effectiveBacktestSettings);
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
        const normalizedResult = normalizeResultSharpe(candidate.result, effectiveInitialCapital);
        if (requiresTradeTimingQualitySort) {
            attachTradeTimingQuality(normalizedResult, candidateData);
        }
        const adjustment = buildSelection(normalizedResult, lastDataTime, effectiveInitialCapital);
        if (requiresTradeTimingQualitySort) {
            attachTradeTimingQuality(adjustment.result, candidateData);
        }
        const enriched: FinderResult = buildFinderResult({
            ...candidate,
            comboMode: Boolean(input.comboPrimarySignals),
            comboPrimaryConfigName: input.options.comboPrimaryConfigName,
            result: normalizedResult,
            selectionResult: adjustment.result,
            compositeEdgeRatio: requiresCompositeEdgeRatioSort
                ? computeFinderCompositeEdgeRatio(normalizedResult, candidateData)
                : undefined,
            endpointAdjusted: adjustment.adjusted,
            endpointRemovedTrades: adjustment.removedTrades,
        });

        if (input.options.tradeFilterEnabled) {
            if (enriched.result.totalTrades < input.options.minTrades || enriched.result.totalTrades > input.options.maxTrades) {
                return;
            }
        }

        filteredCount++;
        if (enriched.endpointAdjusted) {
            endpointAdjustedCount++;
        }
        ranker.offer(enriched);
    };

    const finalizeRun = async (
        processedRunCount: number,
        batchCount: number,
        engineMode: string,
        benchmarkMeta?: RandomBenchmarkMeta
    ): Promise<FinderRunOutput> => {
        const fastTop = ranker.toSortedArray(input.options.topN);
        let trimmed = fastTop;
        const shouldReconcileTopResults = usingCompactBacktest || useRustForFinder;
        if (shouldReconcileTopResults && fastTop.length > 0) {
            callbacks.setStatus("Reconciling top results with full backtest...");
            callbacks.setProgress(99, "Reconciling top results...");
            trimmed = await reconcileSingleTimeframeTopResults(
                fastTop,
                input,
                closedData,
                effectiveCapitalSettings,
                maybeYieldByBudget,
                singleTfPrecomputed,
                preparedDataCache,
                crossSymbolContextMap
            );
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
        statusParts.push(`${trimmed.length} shown`);
        if (flags.isVeryLargeDataset) {
            statusParts.push("(memory-efficient mode)");
        }
        callbacks.setStatus(`Complete. ${statusParts.join(", ")}.`);

        timing.total = performance.now() - runStart;
        debugLogger.event('finder.timing_breakdown', {
            datasetSize: flags.dataSize,
            totalRuns,
            engineMode,
            batchCount,
            durations: {
                signalGeneration: timing.signalGeneration,
                rustBatchRequest: timing.rustBatchRequest,
                tsFallback: timing.tsFallback,
                resultInsertion: timing.resultInsertion,
                total: timing.total,
            },
        });

        let randomBenchmark: FinderRandomBenchmark | undefined;
        if (input.options.mode === "random" && benchmarkMeta) {
            const seconds = Math.max(0.001, timing.total / 1000);
            randomBenchmark = {
                pipeline: benchmarkMeta.pipeline,
                engineMode,
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
                durations: {
                    signalGeneration: timing.signalGeneration,
                    rustBatchRequest: timing.rustBatchRequest,
                    tsFallback: timing.tsFallback,
                    resultInsertion: timing.resultInsertion,
                    total: timing.total,
                },
            });
        }

        return { results: trimmed, randomBenchmark };
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
        !input.options.multiTimeframeEnabled &&
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
        const shortPrecomputed = precomputeIndicators(shortData, effectiveBacktestSettings);
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
            try {
                const jobData = getJobData(job, shortData);
                const tSignalStart = performance.now();
                let signals = generateSignalsForJob(job, jobData, preparedDataCache, effectiveBacktestSettings, getJobCtx(job));
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
                });
                timing.tsFallback += performance.now() - tQuickStart;

                const quickResult = normalizeResultSharpe(quickRawResult, effectiveInitialCapital);
                if (quickMinTrades > 0 && quickResult.totalTrades < quickMinTrades) {
                    signals.length = 0;
                    continue;
                }
                quickCandidates.push({ job, result: quickResult, comparable: buildComparableFinderResult(job.key, job.name, job.params, quickResult) });
                signals.length = 0;
            } catch (error) {
                debugLogger.warn(`[Finder] Random funnel prescreen failed for ${job.key}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            if ((i + 1) % 20 === 0 || i + 1 === allJobs.length) {
                const progress = 10 + ((i + 1) / Math.max(1, allJobs.length)) * 45;
                if (shouldUpdateUi(i + 1 === allJobs.length)) {
                    callbacks.setProgress(progress, `Stage A/B ${i + 1}/${allJobs.length}`);
                }
            }
            await maybeYieldByBudget(i + 1 === allJobs.length);
        }

        quickCandidates.sort((a, b) => compareFinderResults(
            a.comparable,
            b.comparable,
            input.options.sortPriority
        ));
        const shortlisted = quickCandidates.slice(0, shortlistCount);

        callbacks.setStatus(`Random funnel stage C: full backtest on ${shortlisted.length}/${allJobs.length} survivors...`);
        callbacks.setProgress(56, `Stage C ${shortlisted.length} survivors`);

        const backtestFn = usingCompactBacktest ? runBacktestCompact : runBacktest;
        if (!useRustForFinder) {
            for (let i = 0; i < shortlisted.length; i++) {
                const { job } = shortlisted[i];
                if (isCrossSymbolJobSkipped(job)) continue;
                try {
                    const jobData = getJobData(job, closedData);
                    const tSignalStart = performance.now();
                    let signals = generateSignalsForJob(job, jobData, preparedDataCache, effectiveBacktestSettings, getJobCtx(job));
                    timing.signalGeneration += performance.now() - tSignalStart;
                    signals = applyComboMerge(signals, input);

                    const tTsStart = performance.now();
                    runBacktestAndInsert(
                        jobData,
                        signals,
                        job,
                        backtestFn,
                        effectiveCapitalSettings,
                        resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                        getJobPrecomputed(job, singleTfPrecomputed),
                        insertResult,
                        (durationMs) => { timing.resultInsertion += durationMs; }
                    );
                    timing.tsFallback += performance.now() - tTsStart;
                } catch (error) {
                    debugLogger.warn(`[Finder] Random funnel full run failed for ${job.key}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                processedCount = i + 1;
                if ((i + 1) % 10 === 0 || i + 1 === shortlisted.length) {
                    const progress = 56 + ((i + 1) / Math.max(1, shortlisted.length)) * 41;
                    if (shouldUpdateUi(i + 1 === shortlisted.length)) {
                        callbacks.setProgress(progress, `Stage C ${i + 1}/${shortlisted.length}`);
                        callbacks.setStatus(`Processing funnel survivors ${i + 1}/${shortlisted.length}...`);
                    }
                }
                await maybeYieldByBudget(i + 1 === shortlisted.length);
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

        const runBacktestFallback = (run: PreparedRun): void => {
            const tTsStart = performance.now();
            const jobData = getJobData(run.job, closedData);
            runBacktestAndInsert(
                jobData,
                run.signals,
                run.job,
                backtestFn,
                effectiveCapitalSettings,
                resolveFinderCandidateBacktestSettings(run.job.backtestSettings, input.comboPrimarySettings),
                getJobPrecomputed(run.job, singleTfPrecomputed),
                insertResult,
                (durationMs) => { timing.resultInsertion += durationMs; }
            );
            timing.tsFallback += performance.now() - tTsStart;
        };

        for (let batchIndex = 0; batchIndex < totalFunnelBatches; batchIndex++) {
            const batchJobs = shortlistedJobs.slice(batchIndex * funnelBatchSize, (batchIndex + 1) * funnelBatchSize);
            const batchRuns: PreparedRun[] = [];

            const tSignalStart = performance.now();
            for (const job of batchJobs) {
                if (isCrossSymbolJobSkipped(job)) continue;
                try {
                    const jobData = getJobData(job, closedData);
                    let signals = generateSignalsForJob(job, jobData, preparedDataCache, effectiveBacktestSettings, getJobCtx(job));
                    signals = applyComboMerge(signals, input);
                    const evaluation = job.strategy.evaluate?.(jobData, job.params, signals);
                    const entryStats = evaluation?.entryStats;
                    if (job.strategy.metadata?.role === "entry" && entryStats) {
                        const result = buildEntryBacktestResult(entryStats);
                        const insertStartedAt = performance.now();
                        insertResult({
                            key: job.key,
                            name: job.name,
                            params: job.params,
                            result,
                        });
                        timing.resultInsertion += performance.now() - insertStartedAt;
                        signals.length = 0;
                        continue;
                    }

                    batchRuns.push({
                        id: `${job.key}-funnel-${job.id}`,
                        job,
                        signals,
                    });
                } catch (error) {
                    debugLogger.warn(`[Finder] Random funnel signal generation failed for ${job.key}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            timing.signalGeneration += performance.now() - tSignalStart;

            await dispatchRustBatchWithFallback({
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

            processedCount += batchJobs.length;
            const isFinalBatch = batchIndex + 1 === totalFunnelBatches;
            if (shouldUpdateUi(isFinalBatch)) {
                const progress = 56 + (processedCount / Math.max(1, shortlistedJobs.length)) * 41;
                callbacks.setProgress(progress, `Stage C batch ${batchIndex + 1}/${totalFunnelBatches}`);
                callbacks.setStatus(`Processing funnel survivors ${processedCount}/${shortlistedJobs.length} with Rust...`);
            }
            await maybeYieldByBudget(isFinalBatch);
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

    while (processedCount < totalRuns) {
        if (callbacks.isCancelled()) {
            callbacks.setStatus("Finder stopped by user.");
            const trimmed = ranker.toSortedArray(input.options.topN);
            callbacks.onResultsUpdate(trimmed);
            return { results: trimmed };
        }

        const batchJobs = nextJobBatch(flags.batchSize);
        if (batchJobs.length === 0) break;
        batchNum++;

        if (!useRustForFinder) {
            for (const job of batchJobs) {
                if (isCrossSymbolJobSkipped(job)) continue;
                try {
                    const jobData = getJobData(job, closedData);
                    const tSignalStart = performance.now();
                    const signals = generateSignalsForJob(job, jobData, preparedDataCache, effectiveBacktestSettings, getJobCtx(job));
                    timing.signalGeneration += performance.now() - tSignalStart;

                    const mergedSignals = applyComboMerge(signals, input);
                    const tTsStart = performance.now();
                    runBacktestAndInsert(
                        jobData,
                        mergedSignals,
                        job,
                        backtestFn,
                        effectiveCapitalSettings,
                        resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                        getJobPrecomputed(job, singleTfPrecomputed),
                        insertResult,
                        (durationMs) => { timing.resultInsertion += durationMs; }
                    );
                    timing.tsFallback += performance.now() - tTsStart;
                } catch (error) {
                    debugLogger.warn(`[Finder] Backtest failed for ${job.key}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                await maybeYieldByBudget(false);
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
                callbacks.onResultsUpdate(ranker.toSortedArray(input.options.topN));
            }
        }
        await maybeYieldByBudget(true);
            continue;
        }

        const batchRuns: PreparedRun[] = [];

        const runBacktestFallback = (run: PreparedRun): void => {
            const tTsStart = performance.now();
            const jobData = getJobData(run.job, closedData);
            runBacktestAndInsert(
                jobData,
                run.signals,
                run.job,
                backtestFn,
                capitalSettings,
                run.job.backtestSettings,
                getJobPrecomputed(run.job, singleTfPrecomputed),
                insertResult,
                (durationMs) => { timing.resultInsertion += durationMs; }
            );
            timing.tsFallback += performance.now() - tTsStart;
        };

        const tSignalStart = performance.now();
        for (const job of batchJobs) {
            if (isCrossSymbolJobSkipped(job)) continue;
            try {
                const jobData = getJobData(job, closedData);
                const signals = generateSignalsForJob(job, jobData, preparedDataCache, effectiveBacktestSettings, getJobCtx(job));

                const evaluation = job.strategy.evaluate?.(jobData, job.params, signals);
                const entryStats = evaluation?.entryStats;
                if (job.strategy.metadata?.role === "entry" && entryStats) {
                    const result = buildEntryBacktestResult(entryStats);
                    const insertStartedAt = performance.now();
                    insertResult({
                        key: job.key,
                        name: job.name,
                        params: job.params,
                        result,
                    });
                    timing.resultInsertion += performance.now() - insertStartedAt;
                    signals.length = 0;
                    continue;
                }

                batchRuns.push({
                    id: `${job.key}-${job.id}`,
                    job,
                    signals,
                });
            } catch (error) {
                debugLogger.warn(`[Finder] Signal generation failed for ${job.key}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        timing.signalGeneration += performance.now() - tSignalStart;

        if (batchRuns.length === 0) {
            processedCount += batchJobs.length;
            continue;
        }

        await dispatchRustBatchWithFallback({
            batchRuns,
            closedData,
            cacheId,
            capitalSettings,
            rustSettings,
            rustCompactMode: flags.rustCompactMode,
            insertResult,
            runBacktestFallback,
            timing,
            onUnknownRunId: (id) => {
                debugLogger.warn("[Finder] Rust batch returned unknown run id", { id });
            },
            onInconsistentResult: (run) => {
                debugLogger.warn(`[Finder] Rust batch result inconsistent for ${run.job.key}, using TypeScript fallback.`);
            },
        });

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
                callbacks.onResultsUpdate(ranker.toSortedArray(input.options.topN));
            }
        }
        await maybeYieldByBudget(true);
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
            const signals = applySignalPolarity(rawSignals, backtestSettings);
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
            const normalizedResult = normalizeResultSharpe(rawResult, initialCapital);
            if (requiresTradeTimingQualitySort) {
                attachTradeTimingQuality(normalizedResult, jobData);
            }
            const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);
            if (requiresTradeTimingQualitySort) {
                attachTradeTimingQuality(adjustment.result, jobData);
            }

            reconciled.push(buildFinderResult({
                ...candidate,
                params: normalizedParams,
                result: normalizedResult,
                selectionResult: adjustment.result,
                compositeEdgeRatio: requiresCompositeEdgeRatioSort
                    ? computeFinderCompositeEdgeRatio(normalizedResult, jobData)
                    : candidate.compositeEdgeRatio,
                endpointAdjusted: adjustment.adjusted,
                endpointRemovedTrades: adjustment.removedTrades,
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

function normalizeSeed(seed: number | undefined): number {
    if (!Number.isFinite(seed)) return 1;
    const normalized = (Math.floor(Number(seed)) >>> 0);
    return normalized === 0 ? 1 : normalized;
}

function deriveStrategySeed(seed: number | undefined, strategyKey: string): number {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < strategyKey.length; i++) {
        hash ^= strategyKey.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (normalizeSeed(seed) ^ hash) >>> 0;
}

function hasHeavySnapshotFilters(settings: BacktestSettings): boolean {
    return hasNonZeroSnapshotFilter(settings);
}

function computeDatasetFlags(
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

function normalizeResultSharpe(result: BacktestResult, _initialCapital: number): BacktestResult {
    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        return {
            ...result,
            sharpeRatio: calculateSharpeRatioFromEquityCurve(result.equityCurve),
        };
    }

    if (Array.isArray(result.trades) && result.trades.length > 0) {
        return {
            ...result,
            sharpeRatio: calculateSharpeRatioFromReturns(result.trades.map((trade) => trade.pnlPercent)),
        };
    }

    return result;
}

function isBacktestResultConsistent(result: BacktestResult): boolean {
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

function buildSelection(
    raw: BacktestResult,
    lastDataTime: Time | null,
    initialCapital: number
): EndpointSelectionAdjustment {
    return buildSelectionResult(raw, lastDataTime, initialCapital);
}
