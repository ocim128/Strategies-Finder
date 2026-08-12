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
import { withExitStrategyBaseParams } from "./exit-strategy-param-prefix";
import { createSeededRandom } from "../param-math-utils";
import { finderSortRequiresTradeTimingQuality } from "../trade-timing-quality";
import type { CapitalSettings } from "../types/backtest";
import type { FinderDiagnostics, FinderOptions, FinderRandomBenchmark, FinderResult } from "../types/finder";
import { isSecondMarketPolymarketSupported } from "../second-market/evaluation";
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
    const hasPolymarket1sStrategy = selectedStrategies.some((selection) => selection.strategy.polymarket1sConfig);

    // Polymarket classification mode intercepts before any backtest logic
    if (options.polymarketScoringEnabled) {
        const symbolForPolymarketCheck = settings.polymarketOutcomeSymbol?.trim() || input.symbol;
        if (isSecondMarketPolymarketSupported(symbolForPolymarketCheck, input.interval)) {
            const { runSecondMarketFinder } = await import("../second-market/finder-runner");
            return runSecondMarketFinder(input, callbacks);
        }
        if (hasPolymarket1sStrategy) {
            callbacks.setStatus("1s Polymarket context strategies require the 1s CLOB Polymarket Finder.");
            return { results: [] };
        }
        const { runPolymarketFinder } = await import("./finder-runner-polymarket");
        return runPolymarketFinder(input, callbacks);
    }

    if (hasPolymarket1sStrategy) {
        callbacks.setStatus("1s Polymarket context strategies require Polymarket scoring on a supported 1s chart.");
        return { results: [] };
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

    const confirmationStrategyKeys = readConfirmationStrategyKeys(settings.confirmationStrategies);
    await ensureConfirmationStrategiesLoaded(settings);
    const flags = computeDatasetFlags(input.ohlcvData.length, settings, options, confirmationStrategyKeys.length > 0);

    callbacks.setProgress(5, "Preparing parameter combinations...");

    const paramGenerationStartedAt = performance.now();
    const strategyPlans: StrategyPlan[] = [];
    let totalRuns = 0;
    const exitStrategyCandidates = options.exitStrategyOverrideEnabled
        ? (input.exitStrategyCandidates ?? [])
        : [];
    const exitRandom = options.mode === "random" && Number.isFinite(options.randomSeed)
        ? createSeededRandom(Number(options.randomSeed) + 0x9e3779b9)
        : Math.random;
    const exitParamSetsByKey = new Map<string, StrategyParams[]>();
    const getExitParamSets = (selection: FinderSelectedStrategy): StrategyParams[] => {
        const cached = exitParamSetsByKey.get(selection.key);
        if (cached) return cached;

        const generated = input.generateParamSets(selection.strategy.defaultParams, options);
        const normalized = normalizeFinderCandidateParamSets(selection.strategy, generated);
        const paramSets = normalized.length > 0
            ? normalized
            : [{ ...selection.strategy.defaultParams }];
        exitParamSetsByKey.set(selection.key, paramSets);
        return paramSets;
    };

    for (const selection of selectedStrategies) {
        if (exitStrategyCandidates.length > 0) {
            const entryOptions = { ...options, exitStrategyBaseParams: undefined };
            const entryDefaults = buildFinderSearchBaseParams(selection.strategy, settings, entryOptions);
            const entryParamSets = normalizeFinderCandidateParamSets(
                selection.strategy,
                input.generateParamSets(entryDefaults, options)
            );
            const groupedByExit = new Map<string, { selection: FinderSelectedStrategy; paramSets: StrategyParams[] }>();

            for (const entryParams of entryParamSets) {
                const exitSelection = exitStrategyCandidates[Math.floor(exitRandom() * exitStrategyCandidates.length)]!;
                const exitParamSets = getExitParamSets(exitSelection);
                const exitParams = exitParamSets[Math.floor(exitRandom() * exitParamSets.length)] ?? exitSelection.strategy.defaultParams;
                const group = groupedByExit.get(exitSelection.key) ?? {
                    selection: exitSelection,
                    paramSets: [],
                };
                group.paramSets.push({
                    ...entryParams,
                    ...withExitStrategyBaseParams({}, exitParams),
                });
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
            const { backtestSettings, rustBacktestSettings } = resolveFinderRiskOverrides(settings, rustSettings, params, options);

            batch.push({
                id: nextJobId++,
                key: plan.key,
                name: plan.name,
                params,
                backtestSettings,
                rustBacktestSettings,
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
