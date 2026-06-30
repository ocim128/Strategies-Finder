import { applySignalPolarity } from "./strategies/backtest/backtest-utils";
import {
    ensureBuiltInStrategiesLoaded,
    getLoadedBuiltInStrategy,
} from "./strategies/built-in-catalog";
import { parseTimeToUnixSeconds } from "./time-normalization";
import type { BacktestSettings, ConfirmationMode, OHLCVData, Signal, Strategy, StrategyParams } from "./types/strategies";

type ConfirmationSignalExecutor = (
    key: string,
    strategy: Strategy,
    params: StrategyParams
) => Signal[];

type ConfirmationSignalIndex = {
    byBarIndex: Map<number, Signal[]>;
    byTime: Map<number, Signal[]>;
};

const defaultConfirmationSignalCache = new WeakMap<OHLCVData[], Map<string, Signal[]>>();

function resolveConfirmationMode(settings: BacktestSettings): ConfirmationMode {
    const mode = settings.confirmationMode;
    if (
        mode === "veto_opposite"
        || mode === "confirm_within_window"
        || mode === "veto_within_window"
    ) {
        return mode;
    }
    return "agree";
}

function resolveConfirmationWindowBars(settings: BacktestSettings): number {
    const parsed = Number(settings.confirmationWindowBars);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.round(parsed));
}

function addSignalToIndex(index: Map<number, Signal[]>, key: number, signal: Signal): void {
    const existing = index.get(key);
    if (existing) {
        existing.push(signal);
    } else {
        index.set(key, [signal]);
    }
}

function buildDataIndexByTime(data: OHLCVData[]): Map<number, number> {
    const index = new Map<number, number>();
    for (let i = 0; i < data.length; i++) {
        const seconds = parseTimeToUnixSeconds(data[i].time);
        if (seconds !== null) {
            index.set(seconds, i);
        }
    }
    return index;
}

function resolveSignalBarIndex(signal: Signal, dataIndexByTime: Map<number, number>): number | null {
    if (Number.isFinite(signal.barIndex as number)) {
        return Math.trunc(signal.barIndex as number);
    }

    const seconds = parseTimeToUnixSeconds(signal.time);
    return seconds === null ? null : dataIndexByTime.get(seconds) ?? null;
}

function buildSignalIndex(signals: Signal[], dataIndexByTime: Map<number, number>): ConfirmationSignalIndex {
    const byBarIndex = new Map<number, Signal[]>();
    const index = new Map<number, Signal[]>();
    for (const signal of signals) {
        const barIndex = resolveSignalBarIndex(signal, dataIndexByTime);
        if (barIndex !== null) {
            addSignalToIndex(byBarIndex, barIndex, signal);
        }

        const seconds = parseTimeToUnixSeconds(signal.time);
        if (seconds === null) continue;
        addSignalToIndex(index, seconds, signal);
    }
    return { byBarIndex, byTime: index };
}

function hasConfirmationMatch(
    baseSignal: Signal,
    confirmationIndex: ConfirmationSignalIndex,
    dataIndexByTime: Map<number, number>,
    mode: ConfirmationMode,
    windowBars: number
): boolean {
    let hasOpposite = false;
    let hasSame = false;

    const baseBarIndex = resolveSignalBarIndex(baseSignal, dataIndexByTime);
    if (baseBarIndex !== null) {
        const startIndex = baseBarIndex - windowBars;
        const endIndex = baseBarIndex + windowBars;
        for (let barIndex = startIndex; barIndex <= endIndex; barIndex++) {
            const matches = confirmationIndex.byBarIndex.get(barIndex);
            if (!matches) continue;
            for (const match of matches) {
                if (match.type === baseSignal.type) {
                    hasSame = true;
                } else {
                    hasOpposite = true;
                }
            }
        }
    } else {
        const baseTime = parseTimeToUnixSeconds(baseSignal.time);
        if (baseTime === null) return false;

        const startTime = baseTime - windowBars;
        const endTime = baseTime + windowBars;
        for (let time = startTime; time <= endTime; time++) {
            const matches = confirmationIndex.byTime.get(time);
            if (!matches) continue;
            for (const match of matches) {
                if (match.type === baseSignal.type) {
                    hasSame = true;
                } else {
                    hasOpposite = true;
                }
            }
        }
    }

    switch (mode) {
        case "veto_opposite":
            return !hasOpposite;
        case "confirm_within_window":
            return hasSame;
        case "veto_within_window":
            return !hasOpposite;
        case "agree":
        default:
            return hasSame;
    }
}

function mergeConfirmationSignals(
    data: OHLCVData[],
    baseSignals: Signal[],
    confirmationSignals: Signal[],
    settings: BacktestSettings
): Signal[] {
    if (baseSignals.length === 0) return baseSignals;

    const mode = resolveConfirmationMode(settings);
    const windowBars = mode === "agree" || mode === "veto_opposite"
        ? 0
        : resolveConfirmationWindowBars(settings);
    const dataIndexByTime = buildDataIndexByTime(data);
    const confirmationIndex = buildSignalIndex(confirmationSignals, dataIndexByTime);

    return baseSignals.filter((signal) => hasConfirmationMatch(signal, confirmationIndex, dataIndexByTime, mode, windowBars));
}

export function readConfirmationStrategyKeys(value: unknown): string[] {
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

export async function ensureConfirmationStrategiesLoaded(settings: { confirmationStrategies?: unknown } | null | undefined): Promise<void> {
    await ensureBuiltInStrategiesLoaded(readConfirmationStrategyKeys(settings?.confirmationStrategies));
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
    resolveStrategy?: (key: string) => Strategy | undefined;
    executeStrategy?: ConfirmationSignalExecutor;
}): Signal[] {
    const keys = readConfirmationStrategyKeys(args.settings.confirmationStrategies);
    if (keys.length === 0 || args.baseSignals.length === 0) return args.baseSignals;

    const paramsByStrategy = args.settings.confirmationStrategyParams ?? {};
    let mergedSignals = args.baseSignals;

    for (const key of keys) {
        const strategy = args.resolveStrategy?.(key) ?? getLoadedBuiltInStrategy(key);
        if (!strategy) return [];
        if (strategy.crossSymbolConfig || strategy.polymarket1sConfig) return [];

        const rawParams = {
            ...strategy.defaultParams,
            ...(paramsByStrategy[key] ?? {}),
        };
        const params = strategy.normalizeParams ? strategy.normalizeParams(rawParams) : rawParams;
        const confirmationSignals = args.executeStrategy
            ? args.executeStrategy(key, strategy, params)
            : executeDefaultConfirmationStrategy(args.data, args.settings, key, strategy, params);

        mergedSignals = mergeConfirmationSignals(args.data, mergedSignals, confirmationSignals, args.settings);
        if (mergedSignals.length === 0) break;
    }

    return mergedSignals;
}
