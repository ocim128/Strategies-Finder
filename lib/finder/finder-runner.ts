import {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
    buildEntryBacktestResult,
    runBacktest,
    runBacktestCompact,
    runFixedParamWalkForward,
} from "../strategies/index";
import { rustEngine } from "../rust-engine-client";
import { shouldUseRustEngine } from "../engine-preferences";
import { debugLogger } from "../debug-logger";
import {
    buildConfirmationStates,
    filterSignalsWithConfirmations,
    filterSignalsWithConfirmationsBoth,
} from "../confirmation-strategies";
import { calculateSharpeRatioFromReturns } from "../strategies/performance-metrics";
import { buildSelectionResult } from "./endpoint";
import { aggregateFinderBacktestResults, compareFinderResults } from "./finder-engine";
import { FinderResultRanker } from "./finder-result-ranker";
import { hasNonZeroSnapshotFilter, sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import type { FinderDataset } from "./finder-timeframe-loader";
import type { EndpointSelectionAdjustment, FinderOptions, FinderResult } from "../types/finder";
import { trimToClosedCandles } from "../closed-candle-utils";

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
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    getFinderTimeframesForRun: (options: FinderOptions) => string[];
    loadMultiTimeframeDatasets: (symbol: string, intervals: string[]) => Promise<FinderDataset[]>;
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    buildRandomConfirmationParams: (strategyKeys: string[], options: FinderOptions) => Record<string, StrategyParams>;
}

export interface FinderRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
}

export interface FinderRunOutput {
    results: FinderResult[];
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

type CandidateResult = Omit<FinderResult, "selectionResult" | "endpointAdjusted" | "endpointRemovedTrades">;

export async function runFinderExecution(input: FinderRunInput, callbacks: FinderRunCallbacks): Promise<FinderRunOutput> {
    const {
        options,
        settings,
        selectedStrategies,
        initialCapital,
        positionSize,
        commission,
        sizingMode,
        fixedTradeAmount,
    } = input;

    const rustSettings = sanitizeBacktestSettingsForRust(settings);
    const confirmationStrategies = settings.confirmationStrategies ?? [];
    const shouldRandomizeConfirmations = options.mode === "random";
    const hasConfirmationStrategies = confirmationStrategies.length > 0;
    const baseConfirmationParams = settings.confirmationStrategyParams ?? {};
    const runTimeframes = input.getFinderTimeframesForRun(options);
    const usingMultiTimeframe = options.multiTimeframeEnabled === true;

    const flags = computeDatasetFlags(input.ohlcvData.length, settings, options, hasConfirmationStrategies);
    if (flags.isExtremeDataset) {
        debugLogger.warn(`[Finder] EXTREME dataset detected (${flags.dataSize} bars). Using ultra-memory-efficient mode.`);
        callbacks.setStatus(`Ultra-memory mode: ${(flags.dataSize / 1_000_000).toFixed(1)}M bars`);
    } else if (flags.isVeryLargeDataset) {
        debugLogger.warn(`[Finder] Very large dataset detected (${flags.dataSize} bars). Using memory-efficient mode.`);
    }

    callbacks.setProgress(5, "Preparing parameter combinations...");

    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    for (const selection of selectedStrategies) {
        const extendedDefaults = { ...selection.strategy.defaultParams };
        if (settings.riskMode === "percentage") {
            if (settings.stopLossEnabled) {
                extendedDefaults.stopLossPercent = settings.stopLossPercent ?? 5;
            }
            if (settings.takeProfitEnabled) {
                extendedDefaults.takeProfitPercent = settings.takeProfitPercent ?? 10;
            }
        }

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
        if (hasConfirmationStrategies) {
            callbacks.setStatus("robust_random_wf requires confirmation strategies to be disabled.");
            debugLogger.warn("[Finder][robust_random_wf] Confirmation strategies are not supported in this mode.");
            return { results: [] };
        }
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
            const stopLossPercent = params.stopLossPercent;
            const takeProfitPercent = params.takeProfitPercent;
            const hasOverrides = stopLossPercent !== undefined || takeProfitPercent !== undefined;
            const backtestSettings = hasOverrides ? { ...settings } : settings;
            const rustBacktestSettings = hasOverrides ? { ...rustSettings } : rustSettings;

            if (stopLossPercent !== undefined) {
                backtestSettings.stopLossPercent = stopLossPercent;
                rustBacktestSettings.stopLossPercent = stopLossPercent;
            }
            if (takeProfitPercent !== undefined) {
                backtestSettings.takeProfitPercent = takeProfitPercent;
                rustBacktestSettings.takeProfitPercent = takeProfitPercent;
            }

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
        if (!force && (now - lastUiUpdateAt) < 120) return false;
        lastUiUpdateAt = now;
        return true;
    };

    const yieldBudgetMs = flags.isHeavyFinderConfig ? 16 : 28;
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
            hasConfirmationStrategies,
            shouldRandomizeConfirmations,
            confirmationStrategies,
            baseConfirmationParams,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
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
        hasConfirmationStrategies,
        shouldRandomizeConfirmations,
        confirmationStrategies,
        baseConfirmationParams,
        initialCapital,
        positionSize,
        commission,
        sizingMode,
        fixedTradeAmount,
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
    hasConfirmationStrategies: boolean;
    shouldRandomizeConfirmations: boolean;
    confirmationStrategies: string[];
    baseConfirmationParams: Record<string, StrategyParams>;
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    runTimeframes: string[];
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
        hasConfirmationStrategies,
        shouldRandomizeConfirmations,
        confirmationStrategies,
        baseConfirmationParams,
        initialCapital,
        positionSize,
        commission,
        sizingMode,
        fixedTradeAmount,
        runTimeframes,
    } = params;

    callbacks.setProgress(8, `Loading ${runTimeframes.length} timeframe datasets...`);
    callbacks.setStatus(`Loading timeframe datasets (${runTimeframes.length})...`);
    const datasets = await input.loadMultiTimeframeDatasets(input.symbol, runTimeframes);
    const activeDatasets = datasets
        .map((dataset) => ({
            ...dataset,
            data: trimToClosedCandles(dataset.data, dataset.interval),
        }))
        .filter((dataset) => dataset.data.length > 0);

    if (activeDatasets.length === 0) {
        callbacks.setStatus("No data available for selected timeframes.");
        return { results: [] };
    }

    callbacks.setProgress(12, `Running ${totalRuns} runs across ${activeDatasets.length} timeframes...`);

    const fixedConfirmationStatesByInterval = new Map<string, Int8Array[]>();
    if (hasConfirmationStrategies && !shouldRandomizeConfirmations) {
        for (const dataset of activeDatasets) {
            const states = buildConfirmationStates(dataset.data, confirmationStrategies, baseConfirmationParams);
            fixedConfirmationStatesByInterval.set(dataset.interval, states);
        }
    }

    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
    const timeframeLabels = activeDatasets.map((dataset) => dataset.interval);

    while (processedCount < totalRuns) {
        const batchJobs = nextJobBatch(flags.batchSize);
        if (batchJobs.length === 0) break;

        for (const job of batchJobs) {
            let confirmationParamsForJob: Record<string, StrategyParams> | undefined;
            if (hasConfirmationStrategies) {
                if (shouldRandomizeConfirmations) {
                    confirmationParamsForJob = input.buildRandomConfirmationParams(confirmationStrategies, input.options);
                } else if (Object.keys(baseConfirmationParams).length > 0) {
                    confirmationParamsForJob = baseConfirmationParams;
                }
            }

            const timeframeResults: BacktestResult[] = [];
            for (const dataset of activeDatasets) {
                try {
                    let signals = job.strategy.execute(dataset.data, job.params);
                    const confirmationStates = !hasConfirmationStrategies
                        ? []
                        : shouldRandomizeConfirmations
                            ? buildConfirmationStates(dataset.data, confirmationStrategies, confirmationParamsForJob ?? {})
                            : (fixedConfirmationStatesByInterval.get(dataset.interval) ?? []);

                    if (confirmationStates.length > 0) {
                        signals = (job.strategy.metadata?.role === "entry" || input.settings.tradeDirection === "both" || input.settings.tradeDirection === "combined")
                            ? filterSignalsWithConfirmationsBoth(
                                dataset.data,
                                signals,
                                confirmationStates,
                                input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none"
                            )
                            : filterSignalsWithConfirmations(
                                dataset.data,
                                signals,
                                confirmationStates,
                                input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none",
                                input.settings.tradeDirection ?? "long"
                            );
                    }

                    const evaluation = job.strategy.evaluate?.(dataset.data, job.params, signals);
                    const entryStats = evaluation?.entryStats;
                    const datasetUseCompact = dataset.data.length >= flags.compactBacktestThreshold;
                    const timeframeBacktestFn = datasetUseCompact ? runBacktestCompact : runBacktest;
                    const result = job.strategy.metadata?.role === "entry" && entryStats
                        ? buildEntryBacktestResult(entryStats)
                        : timeframeBacktestFn(
                            dataset.data,
                            signals,
                            initialCapital,
                            positionSize,
                            commission,
                            job.backtestSettings,
                            { mode: sizingMode, fixedTradeAmount }
                        );

                    timeframeResults.push(result);
                    signals.length = 0;
                } catch (error) {
                    console.warn(`[Finder] Multi timeframe run failed for ${job.key} @ ${dataset.interval}:`, error);
                }
            }

            if (timeframeResults.length > 0) {
                const aggregatedResult = aggregateFinderBacktestResults(timeframeResults, initialCapital);
                if (input.options.tradeFilterEnabled && aggregatedResult.totalTrades < input.options.minTrades) {
                    processedCount++;
                    await maybeYieldByBudget(processedCount === totalRuns);
                    continue;
                }

                const lastDataTime = activeDatasets.length === 1
                    ? activeDatasets[0].data[activeDatasets[0].data.length - 1]?.time ?? null
                    : null;
                const adjustment = buildSelectionResult(aggregatedResult, lastDataTime, initialCapital);
                const enriched: FinderResult = {
                    key: job.key,
                    name: job.name,
                    timeframes: timeframeLabels,
                    params: job.params,
                    result: aggregatedResult,
                    selectionResult: adjustment.result,
                    endpointAdjusted: adjustment.adjusted,
                    endpointRemovedTrades: adjustment.removedTrades,
                    confirmationParams: confirmationParamsForJob,
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
            if (processedCount % 5 === 0 || processedCount === totalRuns) {
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

interface SingleTimeframeRunParams {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    flags: FinderDatasetFlags;
    totalRuns: number;
    nextJobBatch: (batchSize: number) => ParamJob[];
    shouldUpdateUi: (force?: boolean) => boolean;
    maybeYieldByBudget: (force?: boolean) => Promise<void>;
    hasConfirmationStrategies: boolean;
    shouldRandomizeConfirmations: boolean;
    confirmationStrategies: string[];
    baseConfirmationParams: Record<string, StrategyParams>;
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    rustSettings: BacktestSettings;
}

async function runSingleTimeframe(params: SingleTimeframeRunParams): Promise<FinderRunOutput> {
    const {
        input,
        callbacks,
        flags,
        totalRuns,
        nextJobBatch,
        shouldUpdateUi,
        maybeYieldByBudget,
        hasConfirmationStrategies,
        shouldRandomizeConfirmations,
        confirmationStrategies,
        baseConfirmationParams,
        initialCapital,
        positionSize,
        commission,
        sizingMode,
        fixedTradeAmount,
        rustSettings,
    } = params;
    const closedData = trimToClosedCandles(input.ohlcvData, input.interval);
    if (closedData.length === 0) {
        callbacks.setStatus("No closed candles available for finder run.");
        return { results: [] };
    }

    const confirmationStates = !shouldRandomizeConfirmations && hasConfirmationStrategies
        ? buildConfirmationStates(closedData, confirmationStrategies, baseConfirmationParams)
        : [];
    const buildConfirmationContext = (): { states: Int8Array[]; params?: Record<string, StrategyParams> } => {
        if (!hasConfirmationStrategies) return { states: [] };
        if (!shouldRandomizeConfirmations) {
            return {
                states: confirmationStates,
                params: Object.keys(baseConfirmationParams).length > 0 ? baseConfirmationParams : undefined,
            };
        }

        const confirmationParams = input.buildRandomConfirmationParams(confirmationStrategies, input.options);
        return {
            states: buildConfirmationStates(closedData, confirmationStrategies, confirmationParams),
            params: confirmationParams,
        };
    };

    callbacks.setProgress(10, `Running ${totalRuns} backtests (batch mode)...`);

    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
    const lastDataTime = closedData.length > 0 ? closedData[closedData.length - 1].time : null;

    const rustHealthy = !input.requiresTsEngine && shouldUseRustEngine() && await rustEngine.checkHealth();
    if (input.requiresTsEngine) {
        debugLogger.info("[Finder] Realism settings enabled - forcing TypeScript engine.");
        callbacks.setStatus("Realism settings enabled - using TypeScript engine.");
    }

    let cacheId: string | null = null;
    const useCachedMode = flags.isLargeDataset;
    if (useCachedMode && rustHealthy) {
        callbacks.setStatus("Caching data on Rust engine...");
        callbacks.setProgress(8, "Uploading data to Rust...");
        cacheId = await rustEngine.cacheData(closedData);
        if (cacheId) {
            debugLogger.info(`[Finder] Data cached with ID: ${cacheId} (${flags.dataSize} bars)`);
        } else {
            debugLogger.warn("[Finder] Failed to cache data, falling back to TypeScript");
        }
    }

    const useRustCached = useCachedMode && cacheId !== null;
    const useRustDirect = rustHealthy && !flags.isLargeDataset;
    const rustAvailable = flags.isExtremeDataset ? false : (useRustCached || useRustDirect);
    const forceTsForSharpe = input.options.sortPriority.includes("sharpeRatio") && flags.shouldUseCompactBacktest;
    const useRustForFinder = rustAvailable && !forceTsForSharpe;

    if (forceTsForSharpe && rustAvailable) {
        debugLogger.info("[Finder] Sharpe sort in compact mode - forcing TypeScript for Sharpe consistency.");
    }

    if (flags.isExtremeDataset) {
        debugLogger.info(`[Finder] Extreme dataset (${(flags.dataSize / 1_000_000).toFixed(1)}M bars) - using TypeScript ultra-memory mode`);
        callbacks.setStatus(`Ultra-memory mode: TypeScript only (${(flags.dataSize / 1_000_000).toFixed(1)}M bars)`);
    } else if (flags.isVeryLargeDataset && useRustForFinder) {
        callbacks.setStatus("Using Rust engine with cached data...");
    } else if (!useRustForFinder && flags.isLargeDataset) {
        if (forceTsForSharpe && rustAvailable) {
            debugLogger.info(`[Finder] Using TypeScript for ${flags.dataSize} bars (Rust disabled for Sharpe consistency).`);
        } else {
            debugLogger.warn(`[Finder] Using TypeScript for ${flags.dataSize} bars (Rust unavailable)`);
        }
        callbacks.setStatus("Using TypeScript engine...");
    }

    const insertResult = (candidate: CandidateResult): void => {
        if (input.options.tradeFilterEnabled) {
            const rawTrades = candidate.result.totalTrades;
            if (rawTrades < input.options.minTrades) return;
            if (rawTrades > input.options.maxTrades && (!Array.isArray(candidate.result.trades) || candidate.result.trades.length === 0)) {
                return;
            }
        }

        const normalizedResult = normalizeResultSharpe(candidate.result, initialCapital);
        const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);
        const enriched: FinderResult = {
            ...candidate,
            result: normalizedResult,
            selectionResult: adjustment.result,
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

    const totalBatches = Math.ceil(totalRuns / flags.batchSize);
    let batchNum = 0;
    const backtestFn = flags.shouldUseCompactBacktest ? runBacktestCompact : runBacktest;

    while (processedCount < totalRuns) {
        const batchJobs = nextJobBatch(flags.batchSize);
        if (batchJobs.length === 0) break;
        batchNum++;

        if (!useRustForFinder) {
            for (const job of batchJobs) {
                try {
                    const confirmationContext = buildConfirmationContext();
                    let signals = job.strategy.execute(closedData, job.params);
                    if (confirmationContext.states.length > 0) {
                        signals = (job.strategy.metadata?.role === "entry" || input.settings.tradeDirection === "both" || input.settings.tradeDirection === "combined")
                            ? filterSignalsWithConfirmationsBoth(
                                closedData,
                                signals,
                                confirmationContext.states,
                                input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none"
                            )
                            : filterSignalsWithConfirmations(
                                closedData,
                                signals,
                                confirmationContext.states,
                                input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none",
                                input.settings.tradeDirection ?? "long"
                            );
                    }

                    const evaluation = job.strategy.evaluate?.(closedData, job.params, signals);
                    const entryStats = evaluation?.entryStats;
                    const result = job.strategy.metadata?.role === "entry" && entryStats
                        ? buildEntryBacktestResult(entryStats)
                        : backtestFn(
                            closedData,
                            signals,
                            initialCapital,
                            positionSize,
                            commission,
                            job.backtestSettings,
                            { mode: sizingMode, fixedTradeAmount }
                        );
                    insertResult({
                        key: job.key,
                        name: job.name,
                        params: job.params,
                        result,
                        confirmationParams: confirmationContext.params,
                    });
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

        type PreparedRun = {
            id: string;
            key: string;
            name: string;
            params: StrategyParams;
            signals: Signal[];
            backtestSettings: BacktestSettings;
            rustBacktestSettings: BacktestSettings;
            confirmationParams?: Record<string, StrategyParams>;
        };
        const batchRuns: PreparedRun[] = [];

        const runBacktestFallback = (run: PreparedRun): void => {
            try {
                const result = backtestFn(
                    closedData,
                    run.signals,
                    initialCapital,
                    positionSize,
                    commission,
                    run.backtestSettings,
                    { mode: sizingMode, fixedTradeAmount }
                );
                insertResult({
                    key: run.key,
                    name: run.name,
                    params: run.params,
                    result,
                    confirmationParams: run.confirmationParams,
                });
            } catch (error) {
                console.warn(`[Finder] Backtest failed for ${run.key}:`, error);
            }
        };

        for (const job of batchJobs) {
            try {
                const confirmationContext = buildConfirmationContext();
                let signals = job.strategy.execute(closedData, job.params);
                if (confirmationContext.states.length > 0) {
                    signals = (job.strategy.metadata?.role === "entry" || input.settings.tradeDirection === "both" || input.settings.tradeDirection === "combined")
                        ? filterSignalsWithConfirmationsBoth(
                            closedData,
                            signals,
                            confirmationContext.states,
                            input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none"
                        )
                        : filterSignalsWithConfirmations(
                            closedData,
                            signals,
                            confirmationContext.states,
                            input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none",
                            input.settings.tradeDirection ?? "long"
                        );
                }

                const evaluation = job.strategy.evaluate?.(closedData, job.params, signals);
                const entryStats = evaluation?.entryStats;
                if (job.strategy.metadata?.role === "entry" && entryStats) {
                    const result = buildEntryBacktestResult(entryStats);
                    insertResult({
                        key: job.key,
                        name: job.name,
                        params: job.params,
                        result,
                        confirmationParams: confirmationContext.params,
                    });
                    signals.length = 0;
                    continue;
                }

                batchRuns.push({
                    id: `${job.key}-${job.id}`,
                    key: job.key,
                    name: job.name,
                    params: job.params,
                    signals,
                    backtestSettings: job.backtestSettings,
                    rustBacktestSettings: job.rustBacktestSettings,
                    confirmationParams: confirmationContext.params,
                });
            } catch (error) {
                console.warn(`[Finder] Signal generation failed for ${job.key}:`, error);
            }
            await maybeYieldByBudget(false);
        }

        if (batchRuns.length === 0) {
            processedCount += batchJobs.length;
            continue;
        }

        const batchItems = batchRuns.map((run) => ({
            id: run.id,
            signals: run.signals,
            settings: run.rustBacktestSettings,
        }));

        try {
            const batchResult = cacheId
                ? await rustEngine.runCachedBatchBacktest(
                    cacheId,
                    batchItems,
                    initialCapital,
                    positionSize,
                    commission,
                    rustSettings,
                    { mode: sizingMode, fixedTradeAmount },
                    flags.rustCompactMode
                )
                : await rustEngine.runBatchBacktest(
                    closedData,
                    batchItems,
                    initialCapital,
                    positionSize,
                    commission,
                    rustSettings,
                    { mode: sizingMode, fixedTradeAmount },
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
                        debugLogger.warn(`[Finder] Rust batch result inconsistent for ${run.key}, using TypeScript fallback.`);
                        runBacktestFallback(run);
                        continue;
                    }

                    insertResult({
                        key: run.key,
                        name: run.name,
                        params: run.params,
                        result: batchEntry.result,
                        confirmationParams: run.confirmationParams,
                    });
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

    const fastTop = ranker.toSortedArray(input.options.topN);
    let trimmed = fastTop;
    const shouldReconcileTopResults = flags.shouldUseCompactBacktest || useRustForFinder;
    if (shouldReconcileTopResults && fastTop.length > 0) {
        callbacks.setStatus("Reconciling top results with full backtest...");
        callbacks.setProgress(99, "Reconciling top results...");
        trimmed = await reconcileSingleTimeframeTopResults(
            fastTop,
            input,
            closedData,
            initialCapital,
            positionSize,
            commission,
            sizingMode,
            fixedTradeAmount,
            maybeYieldByBudget
        );
    }

    endpointAdjustedCount = trimmed.reduce((count, item) => count + (item.endpointAdjusted ? 1 : 0), 0);
    callbacks.setProgress(100, totalRuns > 0 ? `${totalRuns}/${totalRuns} runs` : "Complete");
    const statusParts = [`${processedCount} runs`];
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
    return { results: trimmed };
}

async function reconcileSingleTimeframeTopResults(
    candidates: FinderResult[],
    input: FinderRunInput,
    closedData: OHLCVData[],
    initialCapital: number,
    positionSize: number,
    commission: number,
    sizingMode: "percent" | "fixed",
    fixedTradeAmount: number,
    maybeYieldByBudget: (force?: boolean) => Promise<void>
): Promise<FinderResult[]> {
    const strategyByKey = new Map(input.selectedStrategies.map((item) => [item.key, item.strategy]));
    const confirmationStrategies = input.settings.confirmationStrategies ?? [];
    const hasConfirmations = confirmationStrategies.length > 0;
    const tradeFilterMode = input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none";
    const tradeDirection = input.settings.tradeDirection ?? "long";
    const lastDataTime = closedData.length > 0 ? closedData[closedData.length - 1].time : null;
    const reconciled: FinderResult[] = [];

    for (const candidate of candidates) {
        const strategy = strategyByKey.get(candidate.key);
        if (!strategy) {
            reconciled.push(candidate);
            continue;
        }

        try {
            let signals = strategy.execute(closedData, candidate.params);

            if (hasConfirmations) {
                const confirmationParams = candidate.confirmationParams ?? input.settings.confirmationStrategyParams ?? {};
                const confirmationStates = buildConfirmationStates(closedData, confirmationStrategies, confirmationParams);
                if (confirmationStates.length > 0) {
                    signals = (strategy.metadata?.role === "entry" || tradeDirection === "both" || tradeDirection === "combined")
                        ? filterSignalsWithConfirmationsBoth(closedData, signals, confirmationStates, tradeFilterMode)
                        : filterSignalsWithConfirmations(closedData, signals, confirmationStates, tradeFilterMode, tradeDirection);
                }
            }

            const evaluation = strategy.evaluate?.(closedData, candidate.params, signals);
            const entryStats = evaluation?.entryStats;
            const rawResult = strategy.metadata?.role === "entry" && entryStats
                ? buildEntryBacktestResult(entryStats)
                : runBacktest(
                    closedData,
                    signals,
                    initialCapital,
                    positionSize,
                    commission,
                    input.settings,
                    { mode: sizingMode, fixedTradeAmount }
                );
            const normalizedResult = normalizeResultSharpe(rawResult, initialCapital);
            const adjustment = buildSelection(normalizedResult, lastDataTime, initialCapital);

            reconciled.push({
                ...candidate,
                result: normalizedResult,
                selectionResult: adjustment.result,
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

async function runRobustRandomWalkForward(params: RobustRandomRunParams): Promise<FinderRunOutput> {
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

    const robustSettings: BacktestSettings = {
        ...input.settings,
        executionModel: "next_open",
        allowSameBarExit: false,
        slippageBps: Math.max(ROBUST_WF_DEFAULTS.minSlippageBps, input.settings.slippageBps ?? 0),
    };
    const robustCommission = Math.max(ROBUST_WF_DEFAULTS.minCommissionPercent, input.commission);
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
    const cellSeed = deriveCellSeed(runSeed, strategyPlan.key, dataset.interval);
    const rejectionReasons: Record<string, number> = {};
    const recordReject = (reason: string, stage: "A" | "B" | "C", params: StrategyParams) => {
        rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
        debugLogger.info(`[Finder][robust_random_wf][reject][${stage}] ${strategyPlan.key}@${dataset.interval}: ${reason}`, {
            params: summarizeParams(params),
        });
    };

    const stageACandidates: RobustCellCandidate[] = [];
    for (let i = 0; i < paramSets.length; i++) {
        const params = paramSets[i];
        try {
            const holdoutResult = runRobustHoldoutEvaluation(
                dataset.data,
                strategyPlan.strategy,
                params,
                input.initialCapital,
                input.positionSize,
                robustCommission,
                robustSettings,
                input.sizingMode,
                input.fixedTradeAmount
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

    const stageASurvivors = stageACandidates;

    const stageBCandidates: RobustWfCandidate[] = [];
    for (let i = 0; i < stageASurvivors.length; i++) {
        const candidate = stageASurvivors[i];
        try {
            const wfResult = await runRobustFixedParamWalkForward(
                dataset.data,
                strategyPlan.strategy,
                candidate.params,
                ROBUST_WF_DEFAULTS.stageB.targetWindows,
                input.initialCapital,
                input.positionSize,
                robustCommission,
                robustSettings,
                input.sizingMode,
                input.fixedTradeAmount
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

    const stageBSurvivors = stageBCandidates;

    const stageCCandidates: RobustWfCandidate[] = [];
    for (let i = 0; i < stageBSurvivors.length; i++) {
        const candidate = stageBSurvivors[i];
        try {
            const wfResult = await runRobustFixedParamWalkForward(
                dataset.data,
                strategyPlan.strategy,
                candidate.params,
                ROBUST_WF_DEFAULTS.stageC.targetWindows,
                input.initialCapital,
                input.positionSize,
                robustCommission,
                robustSettings,
                input.sizingMode,
                input.fixedTradeAmount
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
        rejectionReasons,
    };
    debugLogger.event("[Finder][robust_random_wf][cell_audit]", auditPayload);

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
        rejectionReasons,
    };

    if (decision !== "PASS" || stageCCandidates.length === 0) {
        return { result: null, diagnostics };
    }

    const best = stageCCandidates[0];
    const result: FinderResult = {
        key: strategyPlan.key,
        name: `${strategyPlan.name} (${dataset.interval})`,
        timeframes: [dataset.interval],
        params: best.params,
        result: normalizeResultSharpe(best.wfResult.combinedOOSTrades, input.initialCapital),
        selectionResult: normalizeResultSharpe(best.wfResult.combinedOOSTrades, input.initialCapital),
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
            rejectionReasons,
        },
    };

    return { result, diagnostics };
}

function runRobustHoldoutEvaluation(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    initialCapital: number,
    positionSize: number,
    commission: number,
    settings: BacktestSettings,
    sizingMode: "percent" | "fixed",
    fixedTradeAmount: number
): BacktestResult {
    const holdoutBars = Math.max(40, Math.floor(data.length * 0.30));
    const holdoutData = data.slice(Math.max(0, data.length - holdoutBars));
    if (holdoutData.length === 0) {
        return createEmptyBacktestResult();
    }

    const signals = strategy.execute(holdoutData, params);
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
            { mode: sizingMode, fixedTradeAmount }
        );
    return normalizeResultSharpe(result, initialCapital);
}

async function runRobustFixedParamWalkForward(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    targetWindows: number,
    initialCapital: number,
    positionSize: number,
    commission: number,
    settings: BacktestSettings,
    sizingMode: "percent" | "fixed",
    fixedTradeAmount: number
): Promise<Awaited<ReturnType<typeof runFixedParamWalkForward>>> {
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
    const compactBacktestThreshold = isHeavyFinderConfig ? 50_000 : 500_000;
    const shouldUseCompactBacktest = dataSize >= compactBacktestThreshold;

    const batchSize = isExtremeDataset
        ? 1
        : isVeryLargeDataset
            ? 2
            : isLargeDataset
                ? 8
                : isHeavyFinderConfig
                    ? 4
                    : 20;

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

function normalizeResultSharpe(result: BacktestResult, initialCapital: number): BacktestResult {
    if (Array.isArray(result.trades) && result.trades.length > 0) {
        return {
            ...result,
            sharpeRatio: calculateSharpeRatioFromReturns(result.trades.map((trade) => trade.pnlPercent)),
        };
    }

    if (Array.isArray(result.equityCurve) && result.equityCurve.length > 1) {
        const returns: number[] = [];
        let prevEquity = initialCapital;
        for (const point of result.equityCurve) {
            if (prevEquity > 0) {
                returns.push((point.value - prevEquity) / prevEquity);
            }
            prevEquity = point.value;
        }
        return {
            ...result,
            sharpeRatio: calculateSharpeRatioFromReturns(returns),
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
