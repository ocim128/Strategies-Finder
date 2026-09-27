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

/** Shared deterministic plan generation for Universe and Arm Performance. */
export function buildFinderCandidatePlans(args: {
    selectedStrategy: FinderCandidateStrategy;
    exitStrategyCandidates: readonly FinderCandidateStrategy[];
    settings: BacktestSettings;
    options: FinderOptions;
    generateParamSets: (defaultParams: StrategyParams, options: FinderOptions) => StrategyParams[];
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

    const randomFn = options.mode === "random" && Number.isFinite(options.randomSeed)
        ? createSeededRandom(Number(options.randomSeed) + 0x9e3779b9)
        : Math.random;
    const exitParamSetsByKey = new Map<string, StrategyParams[]>();
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
