import {
    BacktestSettings,
    OHLCVData,
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
    shouldUseRustCachedMode,
    resolveFinderRiskOverrides,
} from "./finder-runner-core";
import { buildFinderCandidatePlans } from "./finder-candidate-plans";
import { createSeededRandom } from "../param-math-utils";
import { finderSortRequiresTradeTimingQuality } from "../trade-timing-quality";
import { finderSortRequiresExitAlpha } from "./finder-exit-alpha";
import type { CapitalSettings } from "../types/backtest";
import type { FinderDiagnostics, FinderOptions, FinderRandomBenchmark, FinderResult } from "../types/finder";
import {
    ensureConfirmationStrategiesLoaded,
    readConfirmationStrategyKeys,
} from "../confirmation-signal-filter";

export { buildFinderEvaluationData, shouldUseRustCachedMode };

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
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    /** Pre-loaded exit strategy for Exit Strategy Override; undefined when override is off. */
    exitStrategy?: Strategy;
    /** Candidate exit strategies Finder may sample for Exit Strategy Override. */
    exitStrategyCandidates?: FinderSelectedStrategy[];
    /** Aborts an in-flight Rust batch when the current-chart run is stopped. */
    signal?: AbortSignal;
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
    diagnostics?: FinderDiagnostics;
}

export async function runFinderExecution(input: FinderRunInput, callbacks: FinderRunCallbacks): Promise<FinderRunOutput> {
    const { options, settings, selectedStrategies, capitalSettings } = input;
    const rustSettings = sanitizeBacktestSettingsForRust(settings);

    if (finderSortRequiresExitAlpha(options.sortPriority)
        && options.scope !== undefined
        && options.scope !== "current_chart"
        && options.scope !== "symbol_universe") {
        callbacks.setStatus("Exit Alpha sorting is supported in Current Chart and Symbol Universe scopes only.");
        callbacks.setProgress(100, "Unsupported Exit Alpha scope");
        return { results: [] };
    }

    if (options.mode === "genetic") {
        if (finderSortRequiresExitAlpha(options.sortPriority)) {
            callbacks.setStatus("Exit Alpha sorting is not supported in genetic mode.");
            callbacks.setProgress(100, "Unsupported Exit Alpha sort");
            return { results: [] };
        }
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

    const confirmationStrategyKeys = readConfirmationStrategyKeys(settings.confirmationStrategies);
    await ensureConfirmationStrategiesLoaded(settings);
    const flags = computeDatasetFlags(input.ohlcvData.length, options, confirmationStrategyKeys.length > 0);

    callbacks.setProgress(5, "Preparing parameter combinations...");

    const paramGenerationStartedAt = performance.now();
    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    const exitStrategyCandidates = options.exitStrategyOverrideEnabled
        ? (input.exitStrategyCandidates ?? [])
        : [];
    // One draw sequence and one exit-set cache span every selected entry
    // strategy: results must stay reproducible against the flat sample order
    // the pre-planner implementation produced.
    const exitRandom = options.mode === "random" && Number.isFinite(options.randomSeed)
        ? createSeededRandom(Number(options.randomSeed) + 0x9e3779b9)
        : Math.random;
    const exitParamSetsByKey = new Map<string, StrategyParams[]>();
    const exitSelectionByKey = new Map(exitStrategyCandidates.map((candidate) => [candidate.key, candidate]));

    for (const selection of selectedStrategies) {
        if (exitStrategyCandidates.length > 0) {
            // Sampled-exit branch: the shared planner draws the exit strategy
            // and its parameter set per entry candidate; this run owns the
            // continuous RNG and cache so sequences match the seeded baseline.
            const plans = buildFinderCandidatePlans({
                selectedStrategy: selection,
                exitStrategyCandidates,
                settings,
                options,
                generateParamSets: input.generateParamSets,
                randomFn: exitRandom,
                exitParamSetsByKey,
            });
            const groupedByExit = new Map<string, { selection: FinderSelectedStrategy; paramSets: StrategyParams[] }>();

            for (const plan of plans) {
                const exitSelection = exitSelectionByKey.get(plan.exitStrategyKey ?? "");
                if (!exitSelection) continue;
                const group = groupedByExit.get(exitSelection.key) ?? {
                    selection: exitSelection,
                    paramSets: [],
                };
                group.paramSets.push(plan.params);
                groupedByExit.set(exitSelection.key, group);
            }

            for (const group of groupedByExit.values()) {
                if (group.paramSets.length === 0) continue;
                totalRuns += group.paramSets.length;
                strategyPlans.push({
                    key: selection.key,
                    name: selection.name,
                    strategy: selection.strategy,
                    paramSets: group.paramSets,
                    exitStrategy: group.selection.strategy,
                    exitStrategyKey: group.selection.key,
                });
            }
            continue;
        }

        const extendedDefaults = buildFinderSearchBaseParams(selection.strategy, settings, options);
        const paramSets = normalizeFinderCandidateParamSets(
            selection.strategy,
            input.generateParamSets(extendedDefaults, options),
            input.exitStrategy?.normalizeParams
                ? { normalizeExitParams: input.exitStrategy.normalizeParams }
                : undefined
        );
        if (paramSets.length === 0) continue;
        totalRuns += paramSets.length;
        strategyPlans.push({
            key: selection.key,
            name: selection.name,
            strategy: selection.strategy,
            paramSets,
            exitStrategy: input.exitStrategy,
            exitStrategyKey: options.exitStrategyKey,
        });
    }
    const paramGenerationMs = performance.now() - paramGenerationStartedAt;

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
            const backtestSettings = resolveFinderRiskOverrides(settings, params, options);

            batch.push({
                id: nextJobId++,
                key: plan.key,
                name: plan.name,
                params,
                backtestSettings,
                strategy: plan.strategy,
                exitStrategy: plan.exitStrategy,
                exitStrategyKey: plan.exitStrategyKey,
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
        paramGenerationMs,
    });
}
