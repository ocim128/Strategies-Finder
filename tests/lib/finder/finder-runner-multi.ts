import {
    BacktestResult,
    OHLCVData,
    Signal,
    applySignalPolarity,
    precomputeIndicators,
    runBacktest,
    runBacktestCompact,
} from "../strategies/index";
import { mergeStrategySignals } from "../signal-merge";
import { debugLogger } from "../debug-logger";
import { buildSelectionResult } from "./endpoint";
import { aggregateFinderBacktestResults } from "./finder-engine";
import { FinderResultRanker } from "./finder-result-ranker";
import {
    computeAverageCompositeEdgeRatio,
    finderSortRequiresCompositeEdgeRatio,
    type FinderPreparedDataCache,
} from "./finder-runner-core";
import {
    buildFinderResult,
    buildFinderEvaluationData,
    generateSignalsForJob,
    resolveEffectiveCapitalSettings,
    runStrategyBacktest,
    type FinderDatasetFlags,
    type ParamJob,
} from "./finder-runner-shared";
import type { FinderResult } from "../types/finder";
import type { FinderRunCallbacks, FinderRunInput, FinderRunOutput } from "./finder-runner";

export interface MultiTimeframeRunParams {
    input: FinderRunInput;
    callbacks: FinderRunCallbacks;
    flags: FinderDatasetFlags;
    totalRuns: number;
    nextJobBatch: (batchSize: number) => ParamJob[];
    shouldUpdateUi: (force?: boolean) => boolean;
    maybeYieldByBudget: (force?: boolean) => Promise<void>;
    runTimeframes: string[];
}

export async function runMultiTimeframe(params: MultiTimeframeRunParams): Promise<FinderRunOutput> {
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

    const comboPrimarySignalsByInterval = new Map<string, Signal[]>();
    if (input.comboPrimarySignals) {
        const { loadBuiltInStrategyByKey, strategyRegistry } = await import("../../strategyRegistry");
        const { settingsManager } = await import("../settings-manager");
        const { resolveBacktestSettingsFromRaw } = await import("../backtest-settings-resolver");
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
                        let primarySigs: Signal[];
                        try {
                            primarySigs = applySignalPolarity(
                                primaryStrategy.execute(dataset.data, primaryConfig.strategyParams),
                                primarySettings
                            );
                        } catch (error) {
                            const detail = error instanceof Error ? error.message : String(error);
                            debugLogger.error("finder.combo.primary_multitimeframe_failed", {
                                primaryConfigName,
                                primaryStrategy: primaryConfig.strategyKey,
                                timeframe: dataset.interval,
                                error: detail,
                            });
                            callbacks.setStatus(`Combo primary strategy failed on ${dataset.interval}. ${detail}`);
                            return { results: [] };
                        }
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
    let lastResultsUpdateAt = 0;
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
                    const tfPrimarySignals = comboPrimarySignalsByInterval.get(dataset.interval);
                    if (tfPrimarySignals) {
                        signals = mergeStrategySignals(tfPrimarySignals, signals, "and") as Signal[];
                    }
                    const datasetUseCompact = !requiresCompositeEdgeRatioSort && dataset.data.length >= flags.compactBacktestThreshold;
                    const timeframeBacktestFn = datasetUseCompact ? runBacktestCompact : runBacktest;
                    const result = runStrategyBacktest({
                        strategy: job.strategy,
                        data: dataset.data,
                        signals,
                        params: job.params,
                        capitalSettings: effectiveCapitalSettings,
                        backtestSettings: job.backtestSettings,
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
                const now = performance.now();
                if (shouldUpdateUi(processedCount === totalRuns)) {
                    const progress = 12 + (processedCount / totalRuns) * 84;
                    callbacks.setProgress(progress, `${processedCount}/${totalRuns} runs (${activeDatasets.length} TF)`);
                    callbacks.setStatus(`Processing ${processedCount}/${totalRuns} runs across ${activeDatasets.length} timeframes...`);
                }
                if (now - lastResultsUpdateAt > 750 || processedCount === totalRuns) {
                    lastResultsUpdateAt = now;
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
