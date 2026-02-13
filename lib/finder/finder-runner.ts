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
import { aggregateFinderBacktestResults } from "./finder-engine";
import { FinderResultRanker } from "./finder-result-ranker";
import type { FinderDataset } from "./finder-timeframe-loader";
import type { EndpointSelectionAdjustment, FinderOptions, FinderResult } from "../types/finder";

const RUST_UNSUPPORTED_SETTINGS_KEYS = [
    "confirmationStrategies",
    "confirmationStrategyParams",
    "executionModel",
    "allowSameBarExit",
    "slippageBps",
    "marketMode",
    "strategyTimeframeEnabled",
    "strategyTimeframeMinutes",
    "twoHourCloseParity",
    "captureSnapshots",
    "snapshotAtrPercentMin",
    "snapshotAtrPercentMax",
    "snapshotVolumeRatioMin",
    "snapshotVolumeRatioMax",
    "snapshotAdxMin",
    "snapshotAdxMax",
    "snapshotEmaDistanceMin",
    "snapshotEmaDistanceMax",
    "snapshotRsiMin",
    "snapshotRsiMax",
    "snapshotPriceRangePosMin",
    "snapshotPriceRangePosMax",
    "snapshotBarsFromHighMax",
    "snapshotBarsFromLowMax",
    "snapshotTrendEfficiencyMin",
    "snapshotTrendEfficiencyMax",
    "snapshotAtrRegimeRatioMin",
    "snapshotAtrRegimeRatioMax",
    "snapshotBodyPercentMin",
    "snapshotBodyPercentMax",
    "snapshotWickSkewMin",
    "snapshotWickSkewMax",
    "snapshotVolumeTrendMin",
    "snapshotVolumeTrendMax",
    "snapshotVolumeBurstMin",
    "snapshotVolumeBurstMax",
    "snapshotVolumePriceDivergenceMin",
    "snapshotVolumePriceDivergenceMax",
    "snapshotVolumeConsistencyMin",
    "snapshotVolumeConsistencyMax",
    "snapshotCloseLocationMin",
    "snapshotCloseLocationMax",
    "snapshotOppositeWickMin",
    "snapshotOppositeWickMax",
    "snapshotRangeAtrMultipleMin",
    "snapshotRangeAtrMultipleMax",
    "snapshotMomentumConsistencyMin",
    "snapshotMomentumConsistencyMax",
    "snapshotBreakQualityMin",
    "snapshotBreakQualityMax",
    "snapshotTf60PerfMin",
    "snapshotTf60PerfMax",
    "snapshotTf90PerfMin",
    "snapshotTf90PerfMax",
    "snapshotTf120PerfMin",
    "snapshotTf120PerfMax",
    "snapshotTf480PerfMin",
    "snapshotTf480PerfMax",
    "snapshotTfConfluencePerfMin",
    "snapshotTfConfluencePerfMax",
    "snapshotEntryQualityScoreMin",
    "snapshotEntryQualityScoreMax",
] as const;

const SNAPSHOT_FILTER_KEYS = [
    "snapshotAtrPercentMin",
    "snapshotAtrPercentMax",
    "snapshotVolumeRatioMin",
    "snapshotVolumeRatioMax",
    "snapshotAdxMin",
    "snapshotAdxMax",
    "snapshotEmaDistanceMin",
    "snapshotEmaDistanceMax",
    "snapshotRsiMin",
    "snapshotRsiMax",
    "snapshotPriceRangePosMin",
    "snapshotPriceRangePosMax",
    "snapshotBarsFromHighMax",
    "snapshotBarsFromLowMax",
    "snapshotTrendEfficiencyMin",
    "snapshotTrendEfficiencyMax",
    "snapshotAtrRegimeRatioMin",
    "snapshotAtrRegimeRatioMax",
    "snapshotBodyPercentMin",
    "snapshotBodyPercentMax",
    "snapshotWickSkewMin",
    "snapshotWickSkewMax",
    "snapshotVolumeTrendMin",
    "snapshotVolumeTrendMax",
    "snapshotVolumeBurstMin",
    "snapshotVolumeBurstMax",
    "snapshotVolumePriceDivergenceMin",
    "snapshotVolumePriceDivergenceMax",
    "snapshotVolumeConsistencyMin",
    "snapshotVolumeConsistencyMax",
    "snapshotCloseLocationMin",
    "snapshotCloseLocationMax",
    "snapshotOppositeWickMin",
    "snapshotOppositeWickMax",
    "snapshotRangeAtrMultipleMin",
    "snapshotRangeAtrMultipleMax",
    "snapshotMomentumConsistencyMin",
    "snapshotMomentumConsistencyMax",
    "snapshotBreakQualityMin",
    "snapshotBreakQualityMax",
    "snapshotTf60PerfMin",
    "snapshotTf60PerfMax",
    "snapshotTf90PerfMin",
    "snapshotTf90PerfMax",
    "snapshotTf120PerfMin",
    "snapshotTf120PerfMax",
    "snapshotTf480PerfMin",
    "snapshotTf480PerfMax",
    "snapshotTfConfluencePerfMin",
    "snapshotTfConfluencePerfMax",
    "snapshotEntryQualityScoreMin",
    "snapshotEntryQualityScoreMax",
] as const;

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

    const rustSettings = sanitizeSettingsForRust(settings);
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

        const paramSets = input.generateParamSets(extendedDefaults, options);
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

    if (datasets.length === 0) {
        callbacks.setStatus("No data available for selected timeframes.");
        return { results: [] };
    }

    callbacks.setProgress(12, `Running ${totalRuns} runs across ${datasets.length} timeframes...`);

    const fixedConfirmationStatesByInterval = new Map<string, Int8Array[]>();
    if (hasConfirmationStrategies && !shouldRandomizeConfirmations) {
        for (const dataset of datasets) {
            const states = buildConfirmationStates(dataset.data, confirmationStrategies, baseConfirmationParams);
            fixedConfirmationStatesByInterval.set(dataset.interval, states);
        }
    }

    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
    const timeframeLabels = datasets.map((dataset) => dataset.interval);

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
            for (const dataset of datasets) {
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

                const lastDataTime = datasets.length === 1
                    ? datasets[0].data[datasets[0].data.length - 1]?.time ?? null
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
                    callbacks.setProgress(progress, `${processedCount}/${totalRuns} runs (${datasets.length} TF)`);
                    callbacks.setStatus(`Processing ${processedCount}/${totalRuns} runs across ${datasets.length} timeframes...`);
                }
            }
            await maybeYieldByBudget(processedCount === totalRuns);
        }
    }

    const trimmed = ranker.toSortedArray(input.options.topN);
    const statusParts = [
        `${processedCount} runs`,
        `${datasets.length} timeframes`,
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

    const confirmationStates = !shouldRandomizeConfirmations && hasConfirmationStrategies
        ? buildConfirmationStates(input.ohlcvData, confirmationStrategies, baseConfirmationParams)
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
            states: buildConfirmationStates(input.ohlcvData, confirmationStrategies, confirmationParams),
            params: confirmationParams,
        };
    };

    callbacks.setProgress(10, `Running ${totalRuns} backtests (batch mode)...`);

    const ranker = new FinderResultRanker(Math.max(input.options.topN, 50), input.options.sortPriority);
    let processedCount = 0;
    let filteredCount = 0;
    let endpointAdjustedCount = 0;
    const lastDataTime = input.ohlcvData.length > 0 ? input.ohlcvData[input.ohlcvData.length - 1].time : null;

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
        cacheId = await rustEngine.cacheData(input.ohlcvData);
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
                    let signals = job.strategy.execute(input.ohlcvData, job.params);
                    if (confirmationContext.states.length > 0) {
                        signals = (job.strategy.metadata?.role === "entry" || input.settings.tradeDirection === "both" || input.settings.tradeDirection === "combined")
                            ? filterSignalsWithConfirmationsBoth(
                                input.ohlcvData,
                                signals,
                                confirmationContext.states,
                                input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none"
                            )
                            : filterSignalsWithConfirmations(
                                input.ohlcvData,
                                signals,
                                confirmationContext.states,
                                input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none",
                                input.settings.tradeDirection ?? "long"
                            );
                    }

                    const evaluation = job.strategy.evaluate?.(input.ohlcvData, job.params, signals);
                    const entryStats = evaluation?.entryStats;
                    const result = job.strategy.metadata?.role === "entry" && entryStats
                        ? buildEntryBacktestResult(entryStats)
                        : backtestFn(
                            input.ohlcvData,
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
                    input.ohlcvData,
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
                let signals = job.strategy.execute(input.ohlcvData, job.params);
                if (confirmationContext.states.length > 0) {
                    signals = (job.strategy.metadata?.role === "entry" || input.settings.tradeDirection === "both" || input.settings.tradeDirection === "combined")
                        ? filterSignalsWithConfirmationsBoth(
                            input.ohlcvData,
                            signals,
                            confirmationContext.states,
                            input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none"
                        )
                        : filterSignalsWithConfirmations(
                            input.ohlcvData,
                            signals,
                            confirmationContext.states,
                            input.settings.tradeFilterMode ?? input.settings.entryConfirmation ?? "none",
                            input.settings.tradeDirection ?? "long"
                        );
                }

                const evaluation = job.strategy.evaluate?.(input.ohlcvData, job.params, signals);
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
                    input.ohlcvData,
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

    const trimmed = ranker.toSortedArray(input.options.topN);
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

function sanitizeSettingsForRust<T extends object>(settings: T): T {
    const sanitized = { ...settings } as Record<string, unknown>;
    for (const key of RUST_UNSUPPORTED_SETTINGS_KEYS) {
        delete sanitized[key];
    }
    return sanitized as T;
}

function hasHeavySnapshotFilters(settings: Record<string, unknown>): boolean {
    return SNAPSHOT_FILTER_KEYS.some((key) => {
        const value = settings[key];
        return typeof value === "number" && Number.isFinite(value) && value !== 0;
    });
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
    const hasSnapshotFilters = hasHeavySnapshotFilters(settings as unknown as Record<string, unknown>);
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
