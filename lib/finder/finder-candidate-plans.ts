import { createSeededRandom } from "../param-math-utils";
import type { FinderOptions } from "../types/finder";
import type { BacktestSettings, Strategy, StrategyParams } from "../types/strategies";
import {
    buildFinderSearchBaseParams,
    getFinderStrategyParamDefaults,
    normalizeFinderCandidateParamSets,
} from "./finder-runner-core";
import { withExitStrategyBaseParams } from "./exit-strategy-param-prefix";

export interface FinderCandidatePlan {
    params: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyName?: string;
    exitStrategyParams?: StrategyParams;
}

export interface FinderCandidateStrategy {
    key: string;
    name: string;
    strategy: Strategy;
}

/**
 * Shared deterministic plan generation for the current chart, Universe, and
 * Arm Performance.
 *
 * `randomFn` and `exitParamSetsByKey` are explicit overrides for callers that
 * must share ONE draw sequence and exit-set cache across several helper
 * calls (the current-chart run samples continuously across all selected
 * entry strategies). When omitted, each call creates its own seeded or
 * unseeded RNG and its own per-call cache, which is the per-entry-strategy
 * lifetime Universe and Arm rely on. The seed offset and the order of the
 * two random draws per entry candidate are part of the reproducibility
 * contract and must not change.
 */
export function buildFinderCandidatePlans(args: {
    selectedStrategy: FinderCandidateStrategy;
    exitStrategyCandidates: readonly FinderCandidateStrategy[];
    settings: BacktestSettings;
    options: FinderOptions;
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
    /** Explicit RNG; omit to create one from the finder options. */
    randomFn?: () => number;
    /** Explicit lazily-filled exit-set cache; omit for a per-call cache. */
    exitParamSetsByKey?: Map<string, StrategyParams[]>;
}): FinderCandidatePlan[] {
    const { selectedStrategy, exitStrategyCandidates, settings, options, generateParamSets } = args;
    if (exitStrategyCandidates.length === 0) {
        const baseParams = buildFinderSearchBaseParams(selectedStrategy.strategy, settings, options);
        return normalizeFinderCandidateParamSets(
            selectedStrategy.strategy,
            generateParamSets(baseParams, options),
        ).map((params) => ({ params }));
    }

    const entryOptions: FinderOptions = { ...options, exitStrategyBaseParams: undefined };
    const entryBaseParams = buildFinderSearchBaseParams(selectedStrategy.strategy, settings, entryOptions);
    const entryParamSets = normalizeFinderCandidateParamSets(
        selectedStrategy.strategy,
        generateParamSets(entryBaseParams, options),
    );
    if (entryParamSets.length === 0) return [];

    const randomFn = args.randomFn
        ?? (options.mode === "random" && Number.isFinite(options.randomSeed)
            ? createSeededRandom(Number(options.randomSeed) + 0x9e3779b9)
            : Math.random);
    const exitParamSetsByKey = args.exitParamSetsByKey ?? new Map<string, StrategyParams[]>();
    const getExitParamSets = (selection: FinderCandidateStrategy): StrategyParams[] => {
        const cached = exitParamSetsByKey.get(selection.key);
        if (cached) return cached;
        const exitDefaults = getFinderStrategyParamDefaults(selection.strategy);
        const normalized = normalizeFinderCandidateParamSets(
            selection.strategy,
            generateParamSets(exitDefaults, options),
        );
        const paramSets = normalized.length > 0 ? normalized : [{ ...selection.strategy.defaultParams }];
        exitParamSetsByKey.set(selection.key, paramSets);
        return paramSets;
    };

    return entryParamSets.map((entryParams) => {
        const exitSelection = exitStrategyCandidates[Math.floor(randomFn() * exitStrategyCandidates.length)]!;
        const exitParamSets = getExitParamSets(exitSelection);
        const exitParams = exitParamSets[Math.floor(randomFn() * exitParamSets.length)]
            ?? exitSelection.strategy.defaultParams;
        return {
            params: { ...entryParams, ...withExitStrategyBaseParams({}, exitParams) },
            exitStrategyKey: exitSelection.key,
            exitStrategyName: exitSelection.name,
            exitStrategyParams: { ...exitParams },
        };
    });
}
