import { mergeStrategySignals } from "./signal-merge";
import { applySignalPolarity } from "./strategies/backtest/backtest-utils";
import { strategies as builtInStrategies } from "./strategies/library";
import type { BacktestSettings, OHLCVData, Signal, Strategy, StrategyParams } from "./types/strategies";

type ConfirmationSignalExecutor = (
    key: string,
    strategy: Strategy,
    params: StrategyParams
) => Signal[];

const defaultConfirmationSignalCache = new WeakMap<OHLCVData[], Map<string, Signal[]>>();

function readConfirmationStrategyKeys(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const key = item.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
    }
    return keys;
}

function cacheKeyForConfirmation(
    key: string,
    params: StrategyParams,
    settings: BacktestSettings
): string {
    return JSON.stringify({
        key,
        params,
        invertSignals: settings.invertSignals === true,
    });
}

function executeDefaultConfirmationStrategy(
    data: OHLCVData[],
    settings: BacktestSettings,
    key: string,
    strategy: Strategy,
    params: StrategyParams
): Signal[] {
    let cache = defaultConfirmationSignalCache.get(data);
    if (!cache) {
        cache = new Map<string, Signal[]>();
        defaultConfirmationSignalCache.set(data, cache);
    }
    const cacheKey = cacheKeyForConfirmation(key, params, settings);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const signals = applySignalPolarity(strategy.execute(data, params), settings);
    cache.set(cacheKey, signals);
    return signals;
}

export function applyConfirmationStrategiesToSignals(args: {
    data: OHLCVData[];
    baseSignals: Signal[];
    settings: BacktestSettings;
    executeStrategy?: ConfirmationSignalExecutor;
}): Signal[] {
    const keys = readConfirmationStrategyKeys(args.settings.confirmationStrategies);
    if (keys.length === 0 || args.baseSignals.length === 0) return args.baseSignals;

    const paramsByStrategy = args.settings.confirmationStrategyParams ?? {};
    let mergedSignals = args.baseSignals;

    for (const key of keys) {
        const strategy = builtInStrategies[key];
        if (!strategy) return [];

        const rawParams = {
            ...strategy.defaultParams,
            ...(paramsByStrategy[key] ?? {}),
        };
        const params = strategy.normalizeParams ? strategy.normalizeParams(rawParams) : rawParams;
        const confirmationSignals = args.executeStrategy
            ? args.executeStrategy(key, strategy, params)
            : executeDefaultConfirmationStrategy(args.data, args.settings, key, strategy, params);

        mergedSignals = mergeStrategySignals(mergedSignals, confirmationSignals, "and") as Signal[];
        if (mergedSignals.length === 0) break;
    }

    return mergedSignals;
}
