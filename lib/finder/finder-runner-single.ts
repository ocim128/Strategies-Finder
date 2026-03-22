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
    runFixedParamWalkForward,
    applySignalPolarity,
} from "../strategies/index";
import { rustEngine } from "../rust-engine-client";
import { shouldUseRustEngine } from "../engine-preferences";
import { debugLogger, robustAuditSink } from "../debug-logger";
import { strategies as builtInStrategies } from "../strategies/library";

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
    buildFinderSearchBaseParams,
    buildComparableFinderResult,
    compactSignalsForRust,
    computeFinderCompositeEdgeRatio,
    computeAverageCompositeEdgeRatio,
    extractRustFinderCandidates,
    finderSortRequiresCompositeEdgeRatio,
    getPreparedFinderData,
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

export { resolveFinderCandidateBacktestSettings, shouldUseRustCachedMode } from "./finder-runner-core";

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
        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings);

        const generationOptions = options.mode === "robust_random_wf"
            ? { ...options, robustSeed: deriveStrategySeed(options.robustSeed, selection.key) }
            : options;
        const paramSets = input.generateParamSets(extendedDefaults, generationOptions);
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

    if (options.mode === "robust_random_wf") {
        return runRobustRandomWalkForward({
            input,
            callbacks,
            strategyPlans,
            runTimeframes,
        });
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
            const { backtestSettings, rustBacktestSettings } = resolveFinderRiskOverrides(settings, rustSettings, params);

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
        positionSize: effectivePositionSize,
        commission: effectiveCommission,
        sizingMode: effectiveSizingMode,
        fixedTradeAmount: effectiveFixedTradeAmount,
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
        const { strategyRegistry } = await import('../../strategyRegistry');
        const { settingsManager } = await import('../settings-manager');
        const { resolveBacktestSettingsFromRaw } = await import('../backtest-settings-resolver');
        const primaryConfigName = input.options.comboPrimaryConfigName;
        if (primaryConfigName) {
            const primaryConfig = settingsManager.loadStrategyConfig(primaryConfigName);
            if (primaryConfig) {
                const primaryStrategy = strategyRegistry.get(primaryConfig.strategyKey);
                if (primaryStrategy) {
                    const primarySettings = resolveBacktestSettingsFromRaw(
                        primaryConfig.backtestSettings,
                        { captureSnapshots: false, coerceWithoutUiToggles: true }
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
                    const evaluation = job.strategy.evaluate?.(dataset.data, job.params, signals);
                    const entryStats = evaluation?.entryStats;
                    const datasetUseCompact = !requiresCompositeEdgeRatioSort && dataset.data.length >= flags.compactBacktestThreshold;
                    const timeframeBacktestFn = datasetUseCompact ? runBacktestCompact : runBacktest;
                    const result = job.strategy.metadata?.role === "entry" && entryStats
                        ? buildEntryBacktestResult(entryStats)
                        : timeframeBacktestFn(
                            dataset.data,
                            signals,
                            effectiveInitialCapital,
                            effectivePositionSize,
                            effectiveCommission,
                            resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                            { mode: effectiveSizingMode, fixedTradeAmount: effectiveFixedTradeAmount },
                            precomputedByInterval.get(dataset.interval)
                        );

                    timeframeResults.push({ result, data: dataset.data });
                    signals.length = 0;
                } catch (error) {
                    console.warn(`[Finder] Multi timeframe run failed for ${job.key} @ ${dataset.interval}:`, error);
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
                const enriched: FinderResult = {
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
                };

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
                if (shouldUpdateUi(processedCount === totalRuns)) {
                    const progress = 12 + (processedCount / totalRuns) * 84;
                    callbacks.setProgress(progress, `${processedCount}/${totalRuns} runs (${activeDatasets.length} TF)`);
                    callbacks.setStatus(`Processing ${processedCount}/${totalRuns} runs across ${activeDatasets.length} timeframes...`);
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

        let optimization;
        try {
            optimization = await runGeneticOptimization({
                strategyKey: selection.key,
                strategy: selection.strategy,
                data: closedData,
                backtestSettings: input.settings,
                config: {
                    populationSize,
                    generations,
                    eliteCount: Math.max(1, Math.floor(populationSize * 0.15)),
                    mutationRate: 0.2,
                    mutationSigma: 0.18,
                    rangePercent: input.options.rangePercent,
                    seed: deriveStrategySeed(input.options.robustSeed ?? 1337, selection.key),
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
        const candidate: FinderResult = {
            key: selection.key,
            name: selection.name,
            params: optimization.bestGenome.params,
            result: normalizedResult,
            selectionResult: adjustment.result,
            compositeEdgeRatio: finderSortRequiresCompositeEdgeRatio(input.options.sortPriority)
                ? computeFinderCompositeEdgeRatio(normalizedResult, closedData)
                : undefined,
            endpointAdjusted: adjustment.adjusted,
            endpointRemovedTrades: adjustment.removedTrades,
        };

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

/**
 * Shared helper to generate signals for a job.
 * Extracted to eliminate duplication between TS and Rust branches.
 */
function generateSignalsForJob(
    job: ParamJob,
    data: OHLCVData[],
    preparedDataCache?: FinderPreparedDataCache,
    preparedSettings?: BacktestSettings
): Signal[] {
    const preparedFinderData = preparedDataCache
        ? getPreparedFinderData(preparedDataCache, job.key, job.strategy, data, preparedSettings ?? job.backtestSettings)
        : undefined;
    const rawSignals = job.strategy.executePrepared
        ? job.strategy.executePrepared(preparedFinderData, job.params, data)
        : job.strategy.execute(data, job.params);
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
        const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;
        const evaluation = job.strategy.evaluate?.(data, job.params, signals);
        const entryStats = evaluation?.entryStats;
        const result = job.strategy.metadata?.role === "entry" && entryStats
            ? buildEntryBacktestResult(entryStats)
            : backtestFn(
                data,
                signals,
                initialCapital,
                positionSize,
                commission,
                backtestSettings,
                { mode: sizingMode, fixedTradeAmount },
                precomputed
            );
        const insertStartedAt = performance.now();
        insertResult({
            key: job.key,
            name: job.name,
            params: job.params,
            result,
        });
        onInsertTiming?.(performance.now() - insertStartedAt);
    } catch (error) {
        console.warn(`[Finder] Backtest failed for ${job.key}:`, error);
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
        positionSize: effectivePositionSize,
        commission: effectiveCommission,
        sizingMode: effectiveSizingMode,
        fixedTradeAmount: effectiveFixedTradeAmount,
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

    callbacks.setProgress(10, `Running ${totalRuns} backtests (batch mode)...`);

    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    const requiresCompositeEdgeRatioSort = finderSortRequiresCompositeEdgeRatio(input.options.sortPriority);
    const usingCompactBacktest = !requiresCompositeEdgeRatioSort && flags.shouldUseCompactBacktest;
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
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

    const insertResult = (candidate: CandidateResult): void => {
        if (input.options.tradeFilterEnabled) {
            const rawTrades = candidate.result.totalTrades;
            if (rawTrades < input.options.minTrades) return;
            if (rawTrades > input.options.maxTrades && (!Array.isArray(candidate.result.trades) || candidate.result.trades.length === 0)) {
                return;
            }
        }

        const normalizedResult = normalizeResultSharpe(candidate.result, effectiveInitialCapital);
        const adjustment = buildSelection(normalizedResult, lastDataTime, effectiveInitialCapital);
        const enriched: FinderResult = {
            ...candidate,
            comboMode: Boolean(input.comboPrimarySignals),
            comboPrimaryConfigName: input.options.comboPrimaryConfigName,
            result: normalizedResult,
            selectionResult: adjustment.result,
            compositeEdgeRatio: requiresCompositeEdgeRatioSort
                ? computeFinderCompositeEdgeRatio(normalizedResult, closedData)
                : undefined,
            endpointAdjusted: adjustment.adjusted,
            endpointRemovedTrades: adjustment.removedTrades,
        };

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
                maybeYieldByBudget
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

        const baseParams = buildFinderSearchBaseParams(selected.strategy, input.settings);
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
            try {
                const tSignalStart = performance.now();
                let signals = generateSignalsForJob(job, shortData, preparedDataCache, effectiveBacktestSettings);
                timing.signalGeneration += performance.now() - tSignalStart;
                signals = applyComboMerge(signals, input);

                const tQuickStart = performance.now();
                const evaluation = job.strategy.evaluate?.(shortData, job.params, signals);
                const entryStats = evaluation?.entryStats;
                if (job.strategy.metadata?.role !== "entry" && signals.length === 0) {
                    signals.length = 0;
                    continue;
                }
                const quickRawResult = job.strategy.metadata?.role === "entry" && entryStats
                    ? buildEntryBacktestResult(entryStats)
                    : quickBacktestFn(
                        shortData,
                        signals,
                        effectiveInitialCapital,
                        effectivePositionSize,
                        effectiveCommission,
                        resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                        { mode: effectiveSizingMode, fixedTradeAmount: effectiveFixedTradeAmount },
                        shortPrecomputed
                    );
                timing.tsFallback += performance.now() - tQuickStart;

                const quickResult = normalizeResultSharpe(quickRawResult, effectiveInitialCapital);
                if (quickMinTrades > 0 && quickResult.totalTrades < quickMinTrades) {
                    signals.length = 0;
                    continue;
                }
                quickCandidates.push({ job, result: quickResult });
                signals.length = 0;
            } catch (error) {
                console.warn(`[Finder] Random funnel prescreen failed for ${job.key}:`, error);
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
            buildComparableFinderResult(a.job.key, a.job.name, a.job.params, a.result),
            buildComparableFinderResult(b.job.key, b.job.name, b.job.params, b.result),
            input.options.sortPriority
        ));
        const shortlisted = quickCandidates.slice(0, shortlistCount);

        callbacks.setStatus(`Random funnel stage C: full backtest on ${shortlisted.length}/${allJobs.length} survivors...`);
        callbacks.setProgress(56, `Stage C ${shortlisted.length} survivors`);

        const backtestFn = usingCompactBacktest ? runBacktestCompact : runBacktest;
        if (!useRustForFinder) {
            for (let i = 0; i < shortlisted.length; i++) {
                const { job } = shortlisted[i];
                try {
                    const tSignalStart = performance.now();
                    let signals = generateSignalsForJob(job, closedData, preparedDataCache, effectiveBacktestSettings);
                    timing.signalGeneration += performance.now() - tSignalStart;
                    signals = applyComboMerge(signals, input);

                    const tTsStart = performance.now();
                    runBacktestAndInsert(
                        closedData,
                        signals,
                        job,
                        backtestFn,
                        effectiveCapitalSettings,
                        resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                        singleTfPrecomputed,
                        insertResult,
                        (durationMs) => { timing.resultInsertion += durationMs; }
                    );
                    timing.tsFallback += performance.now() - tTsStart;
                } catch (error) {
                    console.warn(`[Finder] Random funnel full run failed for ${job.key}:`, error);
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
            runBacktestAndInsert(
                closedData,
                run.signals,
                run.job,
                backtestFn,
                effectiveCapitalSettings,
                resolveFinderCandidateBacktestSettings(run.job.backtestSettings, input.comboPrimarySettings),
                singleTfPrecomputed,
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
                try {
                    let signals = generateSignalsForJob(job, closedData, preparedDataCache, effectiveBacktestSettings);
                    signals = applyComboMerge(signals, input);
                    const evaluation = job.strategy.evaluate?.(closedData, job.params, signals);
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
                    console.warn(`[Finder] Random funnel signal generation failed for ${job.key}:`, error);
                }
            }
            timing.signalGeneration += performance.now() - tSignalStart;

            if (batchRuns.length > 0) {
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
                            effectiveInitialCapital,
                            effectivePositionSize,
                            effectiveCommission,
                            rustSettings,
                            { mode: effectiveSizingMode, fixedTradeAmount: effectiveFixedTradeAmount },
                            flags.rustCompactMode
                        )
                        : await rustEngine.runBatchBacktest(
                            closedData,
                            batchItems,
                            effectiveInitialCapital,
                            effectivePositionSize,
                            effectiveCommission,
                            rustSettings,
                            { mode: effectiveSizingMode, fixedTradeAmount: effectiveFixedTradeAmount },
                            flags.rustCompactMode
                        );

                    if (batchResult && batchResult.results.length > 0) {
                        const runById = new Map(batchRuns.map((run) => [run.id, run]));
                        const completedRunIds = new Set<string>();

                        for (const batchEntry of batchResult.results) {
                            const run = runById.get(batchEntry.id);
                            if (!run) continue;

                            if (!isBacktestResultConsistent(batchEntry.result)) {
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
                }
                timing.rustBatchRequest += performance.now() - tRustStart;
            }

            for (const run of batchRuns) {
                run.signals.length = 0;
            }

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
        const batchJobs = nextJobBatch(flags.batchSize);
        if (batchJobs.length === 0) break;
        batchNum++;

        if (!useRustForFinder) {
            for (const job of batchJobs) {
                try {
                    const tSignalStart = performance.now();
                    const signals = generateSignalsForJob(job, closedData, preparedDataCache, effectiveBacktestSettings);
                    timing.signalGeneration += performance.now() - tSignalStart;

                    const mergedSignals = applyComboMerge(signals, input);
                    const tTsStart = performance.now();
                    runBacktestAndInsert(
                        closedData,
                        mergedSignals,
                        job,
                        backtestFn,
                        effectiveCapitalSettings,
                        resolveFinderCandidateBacktestSettings(job.backtestSettings, input.comboPrimarySettings),
                        singleTfPrecomputed,
                        insertResult,
                        (durationMs) => { timing.resultInsertion += durationMs; }
                    );
                    timing.tsFallback += performance.now() - tTsStart;
                } catch (error) {
                    console.warn(`[Finder] Backtest failed for ${job.key}:`, error);
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
            }
            await maybeYieldByBudget(true);
            continue;
        }

        const batchRuns: PreparedRun[] = [];

        const runBacktestFallback = (run: PreparedRun): void => {
            const tTsStart = performance.now();
            runBacktestAndInsert(
                closedData,
                run.signals,
                run.job,
                backtestFn,
                capitalSettings,
                run.job.backtestSettings,
                singleTfPrecomputed,
                insertResult,
                (durationMs) => { timing.resultInsertion += durationMs; }
            );
            timing.tsFallback += performance.now() - tTsStart;
        };

        const tSignalStart = performance.now();
        for (const job of batchJobs) {
            try {
                const signals = generateSignalsForJob(job, closedData, preparedDataCache, effectiveBacktestSettings);

                const evaluation = job.strategy.evaluate?.(closedData, job.params, signals);
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
                console.warn(`[Finder] Signal generation failed for ${job.key}:`, error);
            }
        }
        timing.signalGeneration += performance.now() - tSignalStart;

        if (batchRuns.length === 0) {
            processedCount += batchJobs.length;
            continue;
        }

        // Use compact signal shape for Rust payload to reduce transport overhead
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
                    { mode: capitalSettings.sizingMode, fixedTradeAmount: capitalSettings.fixedTradeAmount },
                    flags.rustCompactMode
                )
                : await rustEngine.runBatchBacktest(
                    closedData,
                    batchItems,
                    capitalSettings.initialCapital,
                    capitalSettings.positionSize,
                    capitalSettings.commission,
                    rustSettings,
                    { mode: capitalSettings.sizingMode, fixedTradeAmount: capitalSettings.fixedTradeAmount },
                    flags.rustCompactMode
                );

            if (batchResult && batchResult.results.length > 0) {
                const runById = new Map(batchRuns.map((run) => [run.id, run]));
                const completedRunIds = new Set<string>();

                for (const batchEntry of batchResult.results) {
                    const run = runById.get(batchEntry.id);
                    if (!run) {
                        console.warn(`[Finder] Rust batch returned unknown run id: ${batchEntry.id}`);
                        continue;
                    }

                    if (!isBacktestResultConsistent(batchEntry.result)) {
                        debugLogger.warn(`[Finder] Rust batch result inconsistent for ${run.job.key}, using TypeScript fallback.`);
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
        }
        timing.rustBatchRequest += performance.now() - tRustStart;

        for (const run of batchRuns) {
            run.signals.length = 0;
        }
        batchRuns.length = 0;

        processedCount += batchJobs.length;
        if (shouldUpdateUi(processedCount === totalRuns)) {
            const progress = 10 + (processedCount / totalRuns) * 85;
            callbacks.setProgress(progress, `Batch ${batchNum}/${totalBatches} (${processedCount}/${totalRuns})`);
            if (flags.isExtremeDataset) {
                callbacks.setStatus(`Processing ${batchNum}/${totalBatches} (ultra-memory mode)...`);
            } else {
                callbacks.setStatus(`Processing batch ${batchNum}/${totalBatches}...`);
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
    maybeYieldByBudget: (force?: boolean) => Promise<void>
): Promise<FinderResult[]> {
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;
    const strategyByKey = new Map(input.selectedStrategies.map((item) => [item.key, item.strategy]));
    const requiresCompositeEdgeRatioSort = finderSortRequiresCompositeEdgeRatio(input.options.sortPriority);
    const lastDataTime = closedData.length > 0 ? closedData[closedData.length - 1].time : null;
    const rustSettings = sanitizeBacktestSettingsForRust(input.settings);
    const comboActive = Boolean(input.comboPrimarySignals);
    const comboBacktestSettings = input.comboPrimarySettings ?? input.settings;
    const precomputed = precomputeIndicators(closedData, comboBacktestSettings);
    const preparedDataCache: FinderPreparedDataCache = new WeakMap();
    const reconciled: FinderResult[] = [];

    for (const candidate of candidates) {
        const strategy = strategyByKey.get(candidate.key);
        if (!strategy) {
            reconciled.push(candidate);
            continue;
        }

        try {
            const { backtestSettings } = resolveFinderRiskOverrides(input.settings, rustSettings, candidate.params);
            const preparedFinderData = getPreparedFinderData(
                preparedDataCache,
                candidate.key,
                strategy,
                closedData,
                comboBacktestSettings
            );
            const rawSignals = strategy.executePrepared
                ? strategy.executePrepared(preparedFinderData, candidate.params, closedData)
                : strategy.execute(closedData, candidate.params);
            const signals = applySignalPolarity(rawSignals, backtestSettings);
            const mergedSignals = comboActive ? applyComboMerge(signals, input) : signals;
            const evaluation = strategy.evaluate?.(closedData, candidate.params, mergedSignals);
            const entryStats = evaluation?.entryStats;
            const rawResult = strategy.metadata?.role === "entry" && entryStats
                ? buildEntryBacktestResult(entryStats)
                : runBacktest(
                    closedData,
                    mergedSignals,
                    initialCapital,
                    positionSize,
                    commission,
                    resolveFinderCandidateBacktestSettings(backtestSettings, input.comboPrimarySettings),
                    { mode: sizingMode, fixedTradeAmount },
                    precomputed
                );
            const normalizedResult = normalizeResultSharpe(rawResult, initialCapital);
            const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);

            reconciled.push({
                ...candidate,
                result: normalizedResult,
                selectionResult: adjustment.result,
                compositeEdgeRatio: requiresCompositeEdgeRatioSort
                    ? computeFinderCompositeEdgeRatio(normalizedResult, closedData)
                    : candidate.compositeEdgeRatio,
                endpointAdjusted: adjustment.adjusted,
                endpointRemovedTrades: adjustment.removedTrades,
            });
        } catch (_error) {
            reconciled.push(candidate);
        }

        await maybeYieldByBudget(false);
    }

    return reconciled
        .sort((a, b) => compareFinderResults(a, b, input.options.sortPriority))
        .slice(0, Math.max(1, input.options.topN));
}

type RobustRandomRunParams = {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    strategyPlans: StrategyPlan[];
    runTimeframes: string[];
};

type RobustCellCandidate = {
    params: StrategyParams;
    stageAScore: number;
};

type RobustWfCandidate = {
    params: StrategyParams;
    stageAWfScore: number;
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>;
    medianOOSExpectancy: number;
    medianOOSExpectancyEdge: number;
    medianProfitableFoldRatio: number;
    foldStabilityPenalty: number;
    ddBreachRate: number;
};

type RobustWfMetrics = Pick<RobustWfCandidate, "medianOOSExpectancy" | "medianOOSExpectancyEdge" | "medianProfitableFoldRatio" | "foldStabilityPenalty" | "ddBreachRate">;

type RobustCellEvaluation = {
    result: FinderResult | null;
    diagnostics: {
        strategyKey: string;
        strategyName: string;
        timeframe: string;
        seed: number;
        cellSeed: number;
        sampledParams: number;
        stageASurvivors: number;
        stageBSurvivors: number;
        stageCSurvivors: number;
        passRate: number;
        topDecileMedianOOSExpectancy: number;
        topDecileMedianProfitableFoldRatio: number;
        medianFoldStabilityPenalty: number;
        topDecileMedianDDBreachRate: number;
        robustScore: number;
        decision: "PASS" | "FAIL";
        decisionReason: string;
        rejectionReasons: Record<string, number>;
    };
};

const ROBUST_WF_DEFAULTS = {
    minCommissionPercent: 0.02,
    minSlippageBps: 1,
    minRunsPerCell: 40,
    maxRunsPerCell: 240,
    topDecileFraction: 0.10,
    stageA: {
        minTrades: 8,
        minExpectancy: 0,
        maxDrawdownPercent: 35,
    },
    stageB: {
        targetWindows: 3,
        minTotalTrades: 10,
        minMedianExpectancy: 0,
        minProfitableFoldRatio: 0.50,
        maxDDBreachRate: 0.34,
        maxCombinedDrawdownPercent: 35,
        maxFoldStabilityPenalty: 2.5,
        maxWindowDrawdownPercent: 30,
    },
    stageC: {
        targetWindows: 6,
        minTotalTrades: 20,
        minMedianExpectancy: 0,
        minProfitableFoldRatio: 0.60,
        maxDDBreachRate: 0.20,
        maxCombinedDrawdownPercent: 30,
        maxFoldStabilityPenalty: 1.8,
        maxWindowDrawdownPercent: 25,
    },
    cellGates: {
        minStageCSurvivors: 2,
        minPassRate: 0.01,
        maxTopDecileMedianDDBreachRate: 0.20,
        maxTopDecileMedianFoldStabilityPenalty: 1.8,
    },
    scoreWeights: {
        passRate: 0.60,
        foldRatio: 0.20,
        stability: 0.10,
        expectancyEdge: 0.10,
    },
} as const;

export async function runRobustRandomWalkForward(params: RobustRandomRunParams): Promise<FinderRunOutput> {
    const { input, callbacks, strategyPlans, runTimeframes } = params;
    const closedData = trimToClosedCandles(input.ohlcvData, input.interval);
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for robust finder run.");
        return { results: [] };
    }
    if (!Number.isFinite(input.options.robustSeed)) {
        callbacks.setStatus("robust_random_wf requires a finite seed.");
        debugLogger.warn("[Finder][robust_random_wf] Missing/invalid seed.");
        return { results: [] };
    }
    const runSeed = normalizeSeed(Number(input.options.robustSeed));

    // Start new audit run scope to ensure seed export returns current run only
    robustAuditSink.startRun(`robust-${input.symbol}-${input.interval}-${runSeed}-${Date.now()}`);

    const robustSettings: BacktestSettings = {
        ...input.settings,
        executionModel: "next_open",
        allowSameBarExit: false,
        slippageBps: Math.max(ROBUST_WF_DEFAULTS.minSlippageBps, input.settings.slippageBps ?? 0),
    };
    const robustCommission = Math.max(ROBUST_WF_DEFAULTS.minCommissionPercent, input.capitalSettings.commission);
    debugLogger.info("[Finder][robust_random_wf] Hard gates enforced", {
        seed: runSeed,
        executionModel: robustSettings.executionModel,
        allowSameBarExit: robustSettings.allowSameBarExit,
        slippageBps: robustSettings.slippageBps,
        commissionPercent: robustCommission,
    });
    debugLogger.info("[Finder][robust_random_wf] robustScore = passRate*0.60 + profitableFoldRatio*0.20 + stabilityScore*0.10 + expectancyEdgeScore*0.10");

    let datasets: FinderDataset[] = [];
    if (input.options.multiTimeframeEnabled) {
        callbacks.setProgress(6, `Loading ${runTimeframes.length} timeframe datasets...`);
        datasets = await input.loadMultiTimeframeDatasets(input.symbol, runTimeframes);
    } else {
        datasets = [{ interval: input.interval, data: closedData }];
    }

    const activeDatasets = datasets
        .map((dataset) => ({ ...dataset, data: trimToClosedCandles(dataset.data, dataset.interval) }))
        .filter((dataset) => dataset.data.length > 0);

    if (activeDatasets.length === 0) {
        callbacks.setStatus("No data available for robust finder run.");
        return { results: [] };
    }

    const totalCells = strategyPlans.length * activeDatasets.length;
    let cellIndex = 0;
    const results: FinderResult[] = [];
    const diagnostics: RobustCellEvaluation["diagnostics"][] = [];
    callbacks.setProgress(10, `Running robust scan on ${totalCells} cells...`);

    for (const plan of strategyPlans) {
        for (const dataset of activeDatasets) {
            cellIndex += 1;
            const cellLabel = `${plan.key} @ ${dataset.interval}`;
            callbacks.setStatus(`robust_random_wf: evaluating ${cellLabel} (${cellIndex}/${totalCells})`);

            const sampleBudget = Math.min(
                ROBUST_WF_DEFAULTS.maxRunsPerCell,
                Math.max(ROBUST_WF_DEFAULTS.minRunsPerCell, input.options.maxRuns)
            );
            const cellParamSets = plan.paramSets.slice(0, sampleBudget);

            const evaluation = await evaluateRobustCell({
                strategyPlan: plan,
                dataset,
                input,
                runSeed,
                paramSets: cellParamSets,
                robustSettings,
                robustCommission,
                callbacks,
            });
            diagnostics.push(evaluation.diagnostics);
            if (evaluation.result) {
                results.push(evaluation.result);
            }

            const progress = 10 + (cellIndex / Math.max(1, totalCells)) * 88;
            callbacks.setProgress(progress, `Cells ${cellIndex}/${totalCells}`);
            await callbacks.yieldControl();
        }
    }

    emitRobustClusterReport(diagnostics);

    const sorted = results
        .sort((a, b) => (b.robustMetrics?.robustScore ?? 0) - (a.robustMetrics?.robustScore ?? 0))
        .slice(0, Math.max(1, input.options.topN));

    const passedCells = diagnostics.filter((cell) => cell.decision === "PASS").length;
    callbacks.setProgress(100, "robust_random_wf complete");
    callbacks.setStatus(`Complete. ${passedCells}/${diagnostics.length} cells passed, ${sorted.length} shown.`);
    return { results: sorted };
}

async function evaluateRobustCell(args: {
    strategyPlan: StrategyPlan;
    dataset: FinderDataset;
    input: FinderRunInput;
    runSeed: number;
    paramSets: StrategyParams[];
    robustSettings: BacktestSettings;
    robustCommission: number;
    callbacks: FinderRunCallbacks;
}): Promise<RobustCellEvaluation> {
    const { strategyPlan, dataset, input, runSeed, paramSets, robustSettings, robustCommission, callbacks } = args;
    const robustCapitalSettings: CapitalSettings = {
        ...input.capitalSettings,
        commission: robustCommission,
    };
    const cellSeed = deriveCellSeed(runSeed, strategyPlan.key, dataset.interval);
    const holdoutData = selectRobustHoldoutData(dataset.data);
    const holdoutPrecomputed = holdoutData.length > 0
        ? precomputeIndicators(holdoutData, robustSettings)
        : undefined;
    const holdoutPreparedFinderData = holdoutData.length > 0
        ? strategyPlan.strategy.prepareFinderData?.(holdoutData, robustSettings)
        : undefined;
    // Per-stage rejection tracking to avoid cross-stage count contamination
    const stageRejectionReasons: Record<"A" | "B" | "C", Record<string, number>> = { A: {}, B: {}, C: {} };
    const stageRejectSamples: Record<"A" | "B" | "C", Map<string, StrategyParams[]>> = {
        A: new Map(),
        B: new Map(),
        C: new Map(),
    };

    const recordReject = (reason: string, stage: "A" | "B" | "C", params: StrategyParams) => {
        stageRejectionReasons[stage][reason] = (stageRejectionReasons[stage][reason] ?? 0) + 1;
        // Only store first 3 samples per reason for diagnostics
        const samples = stageRejectSamples[stage].get(reason);
        if (!samples) {
            stageRejectSamples[stage].set(reason, [{ ...params }]);
        } else if (samples.length < 3) {
            samples.push({ ...params });
        }
    };

    // Log aggregated rejects once per stage (using that stage's isolated counters)
    const flushRejectLogs = (stage: "A" | "B" | "C") => {
        const samples = stageRejectSamples[stage];
        const reasons = stageRejectionReasons[stage];
        if (samples.size === 0) return;
        for (const [reason, sampleParams] of samples) {
            debugLogger.info(`[Finder][robust_random_wf][reject][${stage}] ${strategyPlan.key}@${dataset.interval}: ${reason} (count: ${reasons[reason] ?? 0})`, {
                sampleParams: sampleParams.map(summarizeParams),
            });
        }
        samples.clear();
    };

    // Merge per-stage counts into final diagnostics (keeps counts separate per stage)
    const mergeRejectionReasons = (): Record<string, number> => {
        const merged: Record<string, number> = {};
        for (const stage of ["A", "B", "C"] as const) {
            for (const [reason, count] of Object.entries(stageRejectionReasons[stage])) {
                merged[`${reason}`] = (merged[`${reason}`] ?? 0) + count;
            }
        }
        return merged;
    };

    const stageACandidates: RobustCellCandidate[] = [];
    for (let i = 0; i < paramSets.length; i++) {
        const params = paramSets[i];
        const backtestSettings = resolveFinderRiskOverrides(robustSettings, robustSettings, params).backtestSettings;
        try {
            const holdoutResult = runRobustHoldoutEvaluation(
                holdoutData,
                strategyPlan.strategy,
                holdoutPreparedFinderData,
                params,
                robustCapitalSettings,
                backtestSettings,
                holdoutPrecomputed
            );
            const stageAReason = getStageARejectReason(holdoutResult);
            if (stageAReason) {
                recordReject(stageAReason, "A", params);
            } else {
                stageACandidates.push({
                    params,
                    stageAScore: scoreStageAHoldout(holdoutResult),
                });
            }
        } catch (_error) {
            recordReject("stage_a_error", "A", params);
        }

        if ((i + 1) % 12 === 0) {
            await callbacks.yieldControl();
        }
    }

    flushRejectLogs("A");
    const stageASurvivors = stageACandidates;

    const stageBCandidates: RobustWfCandidate[] = [];
    for (let i = 0; i < stageASurvivors.length; i++) {
        const candidate = stageASurvivors[i];
        const backtestSettings = resolveFinderRiskOverrides(robustSettings, robustSettings, candidate.params).backtestSettings;
        try {
            const wfResult = await runRobustFixedParamWalkForward(
                dataset.data,
                strategyPlan.strategy,
                candidate.params,
                ROBUST_WF_DEFAULTS.stageB.targetWindows,
                robustCapitalSettings,
                backtestSettings,
            );
            const metrics = buildRobustWfCandidateMetrics(wfResult, ROBUST_WF_DEFAULTS.stageB.maxWindowDrawdownPercent);
            const stageBReason = getStageBRejectReason(metrics, wfResult);
            if (stageBReason) {
                recordReject(stageBReason, "B", candidate.params);
            } else {
                stageBCandidates.push({
                    params: candidate.params,
                    stageAWfScore: candidate.stageAScore,
                    wfResult,
                    ...metrics,
                });
            }
        } catch (_error) {
            recordReject("stage_b_error", "B", candidate.params);
        }

        if ((i + 1) % 4 === 0) {
            await callbacks.yieldControl();
        }
    }

    flushRejectLogs("B");
    const stageBSurvivors = stageBCandidates;

    const stageCCandidates: RobustWfCandidate[] = [];
    for (let i = 0; i < stageBSurvivors.length; i++) {
        const candidate = stageBSurvivors[i];
        const backtestSettings = resolveFinderRiskOverrides(robustSettings, robustSettings, candidate.params).backtestSettings;
        try {
            const wfResult = await runRobustFixedParamWalkForward(
                dataset.data,
                strategyPlan.strategy,
                candidate.params,
                ROBUST_WF_DEFAULTS.stageC.targetWindows,
                robustCapitalSettings,
                backtestSettings,
            );
            const metrics = buildRobustWfCandidateMetrics(wfResult, ROBUST_WF_DEFAULTS.stageC.maxWindowDrawdownPercent);
            const stageCReason = getStageCRejectReason(metrics, wfResult);
            if (stageCReason) {
                recordReject(stageCReason, "C", candidate.params);
            } else {
                stageCCandidates.push({
                    params: candidate.params,
                    stageAWfScore: candidate.stageAWfScore,
                    wfResult,
                    ...metrics,
                });
            }
        } catch (_error) {
            recordReject("stage_c_error", "C", candidate.params);
        }

        if ((i + 1) % 3 === 0) {
            await callbacks.yieldControl();
        }
    }

    flushRejectLogs("C");
    stageCCandidates.sort((a, b) => compareRobustCandidates(b, a));
    const passRate = paramSets.length > 0 ? stageCCandidates.length / paramSets.length : 0;
    const topDecileCount = Math.max(1, Math.ceil(Math.max(1, stageCCandidates.length) * ROBUST_WF_DEFAULTS.topDecileFraction));
    const topDecile = stageCCandidates.slice(0, topDecileCount);
    const topDecileMedianOOSExpectancy = median(topDecile.map((candidate) => candidate.medianOOSExpectancy));
    const topDecileMedianProfitableFoldRatio = median(topDecile.map((candidate) => candidate.medianProfitableFoldRatio));
    const medianFoldStabilityPenalty = median(topDecile.map((candidate) => candidate.foldStabilityPenalty));
    const topDecileMedianExpectancyEdge = median(topDecile.map((candidate) => candidate.medianOOSExpectancyEdge));
    const topDecileMedianDDBreachRate = median(topDecile.map((candidate) => candidate.ddBreachRate));
    const robustScore = computeRobustScore(
        passRate,
        topDecileMedianProfitableFoldRatio,
        medianFoldStabilityPenalty,
        topDecileMedianExpectancyEdge
    );

    let decision: "PASS" | "FAIL" = "PASS";
    let decisionReason = "cell_pass";
    if (stageCCandidates.length < ROBUST_WF_DEFAULTS.cellGates.minStageCSurvivors) {
        decision = "FAIL";
        decisionReason = "cell_low_stage_c_survivors";
    } else if (passRate < ROBUST_WF_DEFAULTS.cellGates.minPassRate) {
        decision = "FAIL";
        decisionReason = "cell_low_pass_rate";
    } else if (topDecileMedianDDBreachRate > ROBUST_WF_DEFAULTS.cellGates.maxTopDecileMedianDDBreachRate) {
        decision = "FAIL";
        decisionReason = "cell_high_dd_breach_rate";
    } else if (medianFoldStabilityPenalty > ROBUST_WF_DEFAULTS.cellGates.maxTopDecileMedianFoldStabilityPenalty) {
        decision = "FAIL";
        decisionReason = "cell_high_fold_variance";
    }

    const auditPayload = {
        mode: "robust_random_wf" as const,
        strategyKey: strategyPlan.key,
        strategyName: strategyPlan.name,
        symbol: input.symbol,
        tradeFilterMode: robustSettings.tradeFilterMode ?? "none",
        tradeDirection: robustSettings.tradeDirection ?? "short",
        timeframe: dataset.interval,
        seed: runSeed,
        cellSeed,
        sampledParams: paramSets.length,
        stageASurvivors: stageASurvivors.length,
        stageBSurvivors: stageBSurvivors.length,
        stageCSurvivors: stageCCandidates.length,
        passRate,
        topDecileMedianOOSExpectancy,
        topDecileMedianProfitableFoldRatio,
        medianFoldStabilityPenalty,
        topDecileMedianDDBreachRate,
        robustScore,
        decision,
        decisionReason,
        rejectionReasons: mergeRejectionReasons(),
    };
    // Emit to both debug logger (UI) and robust audit sink (complete export)
    debugLogger.event("[Finder][robust_random_wf][cell_audit]", auditPayload);
    robustAuditSink.log("[Finder][robust_random_wf][cell_audit]", auditPayload);

    const diagnostics: RobustCellEvaluation["diagnostics"] = {
        strategyKey: strategyPlan.key,
        strategyName: strategyPlan.name,
        timeframe: dataset.interval,
        seed: runSeed,
        cellSeed,
        sampledParams: paramSets.length,
        stageASurvivors: stageASurvivors.length,
        stageBSurvivors: stageBSurvivors.length,
        stageCSurvivors: stageCCandidates.length,
        passRate,
        topDecileMedianOOSExpectancy,
        topDecileMedianProfitableFoldRatio,
        medianFoldStabilityPenalty,
        topDecileMedianDDBreachRate,
        robustScore,
        decision,
        decisionReason,
        rejectionReasons: mergeRejectionReasons(),
    };

    if (decision !== "PASS" || stageCCandidates.length === 0) {
        return { result: null, diagnostics };
    }

    const best = stageCCandidates[0];
    const robustResult = normalizeResultSharpe(best.wfResult.combinedOOSTrades, input.capitalSettings.initialCapital);
    const result: FinderResult = {
        key: strategyPlan.key,
        name: `${strategyPlan.name} (${dataset.interval})`,
        comboMode: Boolean(input.comboPrimarySignals),
        comboPrimaryConfigName: input.options.comboPrimaryConfigName,
        timeframes: [dataset.interval],
        params: best.params,
        result: robustResult,
        selectionResult: robustResult,
        compositeEdgeRatio: finderSortRequiresCompositeEdgeRatio(input.options.sortPriority)
            ? computeFinderCompositeEdgeRatio(robustResult, dataset.data)
            : undefined,
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
        robustMetrics: {
            mode: "robust_random_wf",
            seed: runSeed,
            cellSeed,
            symbol: input.symbol,
            tradeFilterMode: robustSettings.tradeFilterMode ?? "none",
            tradeDirection: robustSettings.tradeDirection ?? "short",
            decision,
            decisionReason,
            timeframe: dataset.interval,
            sampledParams: paramSets.length,
            stageASurvivors: stageASurvivors.length,
            stageBSurvivors: stageBSurvivors.length,
            stageCSurvivors: stageCCandidates.length,
            passRate,
            topDecileMedianOOSExpectancy,
            topDecileMedianProfitableFoldRatio,
            medianFoldStabilityPenalty,
            topDecileMedianDDBreachRate,
            robustScore,
            rejectionReasons: mergeRejectionReasons(),
        },
    };

    return { result, diagnostics };
}

function selectRobustHoldoutData(data: OHLCVData[]): OHLCVData[] {
    const holdoutBars = Math.max(40, Math.floor(data.length * 0.30));
    return data.slice(Math.max(0, data.length - holdoutBars));
}

function runRobustHoldoutEvaluation(
    holdoutData: OHLCVData[],
    strategy: Strategy,
    preparedFinderData: unknown,
    params: StrategyParams,
    capitalSettings: CapitalSettings,
    settings: BacktestSettings,
    precomputed?: ReturnType<typeof precomputeIndicators>
): BacktestResult {
    if (holdoutData.length === 0) {
        return createEmptyBacktestResult();
    }
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;

    const rawSignals = strategy.executePrepared
        ? strategy.executePrepared(preparedFinderData, params, holdoutData)
        : strategy.execute(holdoutData, params);
    const signals = applySignalPolarity(rawSignals, settings);
    const evaluation = strategy.evaluate?.(holdoutData, params, signals);
    const entryStats = evaluation?.entryStats;
    const result = strategy.metadata?.role === "entry" && entryStats
        ? buildEntryBacktestResult(entryStats)
        : runBacktestCompact(
            holdoutData,
            signals,
            initialCapital,
            positionSize,
            commission,
            settings,
            { mode: sizingMode, fixedTradeAmount },
            precomputed
        );
    return normalizeResultSharpe(result, initialCapital);
}

async function runRobustFixedParamWalkForward(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    targetWindows: number,
    capitalSettings: CapitalSettings,
    settings: BacktestSettings,
): Promise<Awaited<ReturnType<typeof runFixedParamWalkForward>>> {
    const { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount } = capitalSettings;
    const testWindow = Math.max(20, Math.floor(data.length / Math.max(2, targetWindows)));
    const stepSize = testWindow;
    return runFixedParamWalkForward(
        data,
        strategy,
        {
            testWindow,
            stepSize,
            fixedParams: params,
            minTrades: 1,
        },
        initialCapital,
        positionSize,
        commission,
        settings,
        { mode: sizingMode, fixedTradeAmount }
    );
}

function buildRobustWfCandidateMetrics(
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>,
    maxWindowDrawdownPercent: number
): RobustWfMetrics {
    const oosWindows = wfResult.windows.map((window) => window.outOfSampleResult);
    const expectancies = oosWindows.map((window) => window.expectancy);
    const profitableFoldRatio = oosWindows.length > 0
        ? oosWindows.filter((window) => window.expectancy > 0 && window.netProfit > 0).length / oosWindows.length
        : 0;
    const ddBreachRate = oosWindows.length > 0
        ? oosWindows.filter((window) => window.maxDrawdownPercent > maxWindowDrawdownPercent).length / oosWindows.length
        : 1;
    const medianOOSExpectancy = median(expectancies);
    const foldStabilityPenalty = stdDev(expectancies) / (Math.abs(medianOOSExpectancy) + 1);
    const denom = Math.max(1, Math.abs(wfResult.combinedOOSTrades.avgLoss || wfResult.combinedOOSTrades.avgTrade || 0));
    const expectancyEdge = wfResult.combinedOOSTrades.expectancy / denom;
    return {
        medianOOSExpectancy,
        medianOOSExpectancyEdge: expectancyEdge,
        medianProfitableFoldRatio: profitableFoldRatio,
        foldStabilityPenalty,
        ddBreachRate,
    };
}

function getStageARejectReason(result: BacktestResult): string | null {
    if (result.totalTrades < ROBUST_WF_DEFAULTS.stageA.minTrades) return "stage_a_low_trades";
    if (result.expectancy <= ROBUST_WF_DEFAULTS.stageA.minExpectancy) return "stage_a_non_positive_expectancy";
    if (result.maxDrawdownPercent > ROBUST_WF_DEFAULTS.stageA.maxDrawdownPercent) return "stage_a_high_drawdown";
    return null;
}

function getStageBRejectReason(
    candidate: RobustWfMetrics,
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>
): string | null {
    const totalTrades = wfResult.combinedOOSTrades.totalTrades;
    const maxDrawdownPercent = wfResult.combinedOOSTrades.maxDrawdownPercent;
    if (totalTrades < ROBUST_WF_DEFAULTS.stageB.minTotalTrades) return "stage_b_low_oos_trades";
    if (candidate.medianOOSExpectancy <= ROBUST_WF_DEFAULTS.stageB.minMedianExpectancy) return "stage_b_non_positive_expectancy";
    if (candidate.medianProfitableFoldRatio < ROBUST_WF_DEFAULTS.stageB.minProfitableFoldRatio) return "stage_b_low_profitable_fold_ratio";
    if (candidate.ddBreachRate > ROBUST_WF_DEFAULTS.stageB.maxDDBreachRate) return "stage_b_high_window_dd_breach_rate";
    if (maxDrawdownPercent > ROBUST_WF_DEFAULTS.stageB.maxCombinedDrawdownPercent) return "stage_b_high_combined_drawdown";
    if (candidate.foldStabilityPenalty > ROBUST_WF_DEFAULTS.stageB.maxFoldStabilityPenalty) return "stage_b_unstable_fold_expectancy";
    return null;
}

function getStageCRejectReason(
    candidate: RobustWfMetrics,
    wfResult: Awaited<ReturnType<typeof runFixedParamWalkForward>>
): string | null {
    const totalTrades = wfResult.combinedOOSTrades.totalTrades;
    const maxDrawdownPercent = wfResult.combinedOOSTrades.maxDrawdownPercent;
    if (totalTrades < ROBUST_WF_DEFAULTS.stageC.minTotalTrades) return "stage_c_low_oos_trades";
    if (candidate.medianOOSExpectancy <= ROBUST_WF_DEFAULTS.stageC.minMedianExpectancy) return "stage_c_non_positive_expectancy";
    if (candidate.medianProfitableFoldRatio < ROBUST_WF_DEFAULTS.stageC.minProfitableFoldRatio) return "stage_c_low_profitable_fold_ratio";
    if (candidate.ddBreachRate > ROBUST_WF_DEFAULTS.stageC.maxDDBreachRate) return "stage_c_high_window_dd_breach_rate";
    if (maxDrawdownPercent > ROBUST_WF_DEFAULTS.stageC.maxCombinedDrawdownPercent) return "stage_c_high_combined_drawdown";
    if (candidate.foldStabilityPenalty > ROBUST_WF_DEFAULTS.stageC.maxFoldStabilityPenalty) return "stage_c_unstable_fold_expectancy";
    return null;
}

function scoreStageAHoldout(result: BacktestResult): number {
    return result.expectancy + Math.min(4, result.profitFactor) - (result.maxDrawdownPercent * 0.05);
}

function compareRobustCandidates(a: RobustWfCandidate, b: RobustWfCandidate): number {
    if (Math.abs(a.medianOOSExpectancy - b.medianOOSExpectancy) > 1e-9) {
        return a.medianOOSExpectancy - b.medianOOSExpectancy;
    }
    if (Math.abs(a.medianProfitableFoldRatio - b.medianProfitableFoldRatio) > 1e-9) {
        return a.medianProfitableFoldRatio - b.medianProfitableFoldRatio;
    }
    if (Math.abs(a.foldStabilityPenalty - b.foldStabilityPenalty) > 1e-9) {
        return b.foldStabilityPenalty - a.foldStabilityPenalty;
    }
    return a.stageAWfScore - b.stageAWfScore;
}

function computeRobustScore(
    passRate: number,
    profitableFoldRatio: number,
    foldStabilityPenalty: number,
    expectancyEdge: number
): number {
    const passRatePct = clamp01(passRate) * 100;
    const foldRatioPct = clamp01(profitableFoldRatio) * 100;
    const stabilityScore = Math.max(0, 100 - Math.min(100, foldStabilityPenalty * 100));
    const expectancyEdgeScore = Math.max(0, Math.min(100, expectancyEdge * 100));
    const score = (
        passRatePct * ROBUST_WF_DEFAULTS.scoreWeights.passRate +
        foldRatioPct * ROBUST_WF_DEFAULTS.scoreWeights.foldRatio +
        stabilityScore * ROBUST_WF_DEFAULTS.scoreWeights.stability +
        expectancyEdgeScore * ROBUST_WF_DEFAULTS.scoreWeights.expectancyEdge
    );
    return Math.max(0, Math.min(100, score));
}

function emitRobustClusterReport(cells: RobustCellEvaluation["diagnostics"][]): void {
    const grouped = new Map<string, { total: number; passed: number; passRates: number[] }>();
    for (const cell of cells) {
        const bucket = grouped.get(cell.strategyKey) ?? { total: 0, passed: 0, passRates: [] };
        bucket.total += 1;
        if (cell.decision === "PASS") bucket.passed += 1;
        bucket.passRates.push(cell.passRate);
        grouped.set(cell.strategyKey, bucket);
    }
    grouped.forEach((bucket, strategyKey) => {
        debugLogger.info(`[Finder][robust_random_wf][cluster] ${strategyKey}: ${bucket.passed}/${bucket.total} cells passed`, {
            medianCellPassRate: median(bucket.passRates),
        });
    });
}

function summarizeParams(params: StrategyParams): string {
    return Object.entries(params)
        .slice(0, 10)
        .map(([key, value]) => `${key}=${Number.isInteger(value) ? value : value.toFixed(4)}`)
        .join(", ");
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

function deriveCellSeed(seed: number, strategyKey: string, timeframe: string): number {
    return deriveStrategySeed(seed, `${strategyKey}|${timeframe}`);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function median(values: number[]): number {
    const cleaned = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (cleaned.length === 0) return 0;
    const mid = Math.floor(cleaned.length / 2);
    return cleaned.length % 2 === 0 ? (cleaned[mid - 1] + cleaned[mid]) / 2 : cleaned[mid];
}

function stdDev(values: number[]): number {
    const cleaned = values.filter((value) => Number.isFinite(value));
    if (cleaned.length <= 1) return 0;
    const avg = cleaned.reduce((sum, value) => sum + value, 0) / cleaned.length;
    const variance = cleaned.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / cleaned.length;
    return Math.sqrt(Math.max(0, variance));
}

function createEmptyBacktestResult(): BacktestResult {
    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
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
