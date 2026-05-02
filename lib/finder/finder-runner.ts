import {
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
} from "../strategies/index";
import { sanitizeBacktestSettingsForRust } from "../rust-settings-sanitizer";
import {
    computeDatasetFlags,
    buildFinderEvaluationData,
    type ParamJob,
    type StrategyPlan,
} from "./finder-runner-shared";
import {
    buildFinderSearchBaseParams,
    normalizeFinderCandidateParamSets,
    resolveFinderCandidateBacktestSettings,
    shouldUseRustCachedMode,
    resolveFinderRiskOverrides,
} from "./finder-runner-core";
import { finderSortRequiresTradeTimingQuality } from "../trade-timing-quality";
import type { FinderDataset } from "./finder-timeframe-loader";
import type { CapitalSettings } from "../types/backtest";
import type { FinderOptions, FinderRandomBenchmark, FinderResult } from "../types/finder";

export { buildFinderEvaluationData, resolveFinderCandidateBacktestSettings, shouldUseRustCachedMode };

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
    comboPrimarySignals?: Signal[];
    comboPrimarySettings?: BacktestSettings;
    comboPrimaryCapital?: CapitalSettings;
}

export interface FinderRunCallbacks {
    setProgress: (percent: number, text: string) => void;
    setStatus: (text: string) => void;
    yieldControl: () => Promise<void>;
    isCancelled: () => boolean;
    onResultsUpdate: (results: FinderResult[]) => void;
    onStrategyPlanStart?: (info: {
        index: number;
        total: number;
        key: string;
        name: string;
    }) => void;
}

export interface FinderRunOutput {
    results: FinderResult[];
    randomBenchmark?: FinderRandomBenchmark;
}

export async function runFinderExecution(input: FinderRunInput, callbacks: FinderRunCallbacks): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies, capitalSettings } = input;
    const rustSettings = sanitizeBacktestSettingsForRust(settings);

    const flags = computeDatasetFlags(input.ohlcvData.length, settings, options, false);

    // Polymarket classification mode intercepts before any backtest logic
    if (options.polymarketScoringEnabled) {
        const { runPolymarketFinder } = await import("./finder-runner-polymarket");
        return runPolymarketFinder(input, callbacks);
    }

    if (options.mode === "genetic") {
        if (finderSortRequiresTradeTimingQuality(options.sortPriority)) {
            callbacks.setStatus("Entry Score and Exit Score sorting are supported in grid and random modes only.");
            callbacks.setProgress(100, "Unsupported timing-score sort");
            return { results: [] };
        }
        const { runGeneticFinder } = await import("./finder-runner-genetic");
        return runGeneticFinder({
            input,
            callbacks,
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

            if (paramIndex === 0) {
                callbacks.onStrategyPlanStart?.({
                    index: planIndex + 1,
                    total: strategyPlans.length,
                    key: plan.key,
                    name: plan.name,
                });
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

    const { runSingleTimeframe } = await import("./finder-runner-single");
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
