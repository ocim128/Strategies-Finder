/**
 * Helpers for the Exit Strategy Override feature inside the Finder.
 *
 * The Finder varies the exit strategy's params alongside the entry strategy's params
 * in one combined param space. To avoid key collisions when both strategies share a
 * param name (e.g. `lookback`), exit-strategy params are stored under prefixed keys
 * (`_exit__lookback`) inside the combined `StrategyParams` object.
 *
 * These helpers add the prefix when building base params, and split it back out when
 * handing params to the entry strategy's normalizer / the exit strategy's executor.
 */
import type { StrategyParams } from "../types/strategies";

export const EXIT_STRATEGY_PARAM_PREFIX = "_exit__";

/** True when a param key belongs to the exit strategy (has the prefix). */
export function isExitStrategyParamKey(key: string): boolean {
    return key.startsWith(EXIT_STRATEGY_PARAM_PREFIX);
}

/** Strip the prefix to recover the original exit-strategy param key. */
export function stripExitStrategyParamPrefix(key: string): string {
    return key.slice(EXIT_STRATEGY_PARAM_PREFIX.length);
}

/** Add the prefix to an exit-strategy param key. */
export function addExitStrategyParamPrefix(key: string): string {
    return `${EXIT_STRATEGY_PARAM_PREFIX}${key}`;
}

/**
 * Merge an exit strategy's default params into a base param set with the prefix applied.
 * Caller is responsible for ensuring `exitBaseParams` came from the resolved exit strategy.
 */
export function withExitStrategyBaseParams(
    baseParams: StrategyParams,
    exitBaseParams?: StrategyParams
): StrategyParams {
    if (!exitBaseParams || Object.keys(exitBaseParams).length === 0) {
        return baseParams;
    }
    const merged: StrategyParams = { ...baseParams };
    for (const [key, value] of Object.entries(exitBaseParams)) {
        merged[addExitStrategyParamPrefix(key)] = value;
    }
    return merged;
}

/**
 * Split a combined candidate param object into entry-strategy params and exit-strategy params.
 * The entry half keeps only non-prefixed keys; the exit half has the prefix stripped.
 */
export function splitExitStrategyParams(combined: StrategyParams): {
    entryParams: StrategyParams;
    exitParams: StrategyParams;
} {
    const entryParams: StrategyParams = {};
    const exitParams: StrategyParams = {};
    for (const [key, value] of Object.entries(combined)) {
        if (isExitStrategyParamKey(key)) {
            exitParams[stripExitStrategyParamPrefix(key)] = value;
        } else {
            entryParams[key] = value;
        }
    }
    return { entryParams, exitParams };
}
