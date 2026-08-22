import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyExecutionContext,
    StrategyParams,
} from "../strategies";
import { computeEdgeStatistics } from "../strategies/backtest/edge-statistics";
import type { FinderMetric, FinderOptions, FinderResult } from "../types/finder";
import { splitExitStrategyParams, withExitStrategyBaseParams } from "./exit-strategy-param-prefix";

export type FinderPreparedDataCache = WeakMap<OHLCVData[], Map<string, unknown>>;

/**
 * Asset Opportunity only needs full per-bar analytics while ranking when the
 * active sort explicitly reads them. Expectancy, profit factor, net profit,
 * and trade counts come from the lean candidate result unchanged.
 */
export function finderAssetSearchRequiresFullAnalytics(
    sortPriority: readonly FinderMetric[],
): boolean {
    return sortPriority.includes("sharpeRatio")
        || sortPriority.includes("maxDrawdownPercent");
}

/**
 * Wrap a strategy with the existing Finder prepared-data contract while
 * preserving all of its metadata and non-signal methods.
 */
export function createPreparedFinderStrategy(
    strategyKey: string,
    strategy: Strategy,
    cache: FinderPreparedDataCache,
    getSettings: () => BacktestSettings,
): Strategy {
    if (!strategy.prepareFinderData || !strategy.executePrepared) return strategy;

    const wrapped = Object.create(Object.getPrototypeOf(strategy)) as Strategy;
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(strategy));
    wrapped.execute = (
        data: OHLCVData[],
        params: StrategyParams,
        executionContext?: StrategyExecutionContext,
    ) => {
        const settings = getSettings();
        if (settings.strategyTimeframeEnabled === true) {
            return strategy.execute(data, params, executionContext);
        }
        const prepared = getPreparedFinderData(
            cache,
            strategyKey,
            strategy,
            data,
            settings,
            executionContext,
        );
        return strategy.executePrepared!(prepared, params, data, executionContext) ?? [];
    };
    return wrapped;
}

type CompactSignal = {
    time: Signal["time"];
    type: Signal["type"];
    price: Signal["price"];
    barIndex: Signal["barIndex"];
};

export type CandidateResult = Omit<FinderResult, "selectionResult" | "endpointAdjusted" | "endpointRemovedTrades">;

export type RustFinderCandidatePayload = {
    key: string;
    name: string;
    params: StrategyParams;
    result: BacktestResult;
};

export type QuickFunnelCandidate = {
    job: {
        id: number;
        key: string;
        name: string;
        params: StrategyParams;
        backtestSettings: BacktestSettings;
        rustBacktestSettings: BacktestSettings;
        strategy: Strategy;
        exitStrategy?: Strategy;
        exitStrategyKey?: string;
    };
    result: BacktestResult;
    comparable: FinderResult;
};

export type RandomBenchmarkMeta = {
    pipeline: "standard" | "rust_native" | "ts_funnel" | "rust_funnel";
    prescreenRuns: number;
    fullRuns: number;
    shortlistRuns: number;
    shortBars: number;
    shortCoverage: number;
    rustCandidateCount: number;
};

type TakeProfitMode = NonNullable<BacktestSettings["takeProfitMode"]>;
type PathExitMode = NonNullable<BacktestSettings["pathExitMode"]>;

type TpParamSpec = {
    key: keyof BacktestSettings & string;
    mode?: TakeProfitMode;
    clamp: (value: number) => number;
};

type PathExitParamSpec = {
    key: keyof BacktestSettings & string;
    modes: readonly PathExitMode[];
    value?: (settings: BacktestSettings) => unknown;
    clamp: (value: number) => number;
};

export function shouldUseRustCachedMode(
    dataSize: number,
    totalRuns: number,
    batchSize: number,
    options?: { minBatchesForCache?: number }
): { useCache: boolean; reason: "large_dataset" | "high_batch_count" | "none" } {
    const normalizedDataSize = Number.isFinite(dataSize) ? Math.max(0, Math.floor(dataSize)) : 0;
    const normalizedTotalRuns = Number.isFinite(totalRuns) ? Math.max(0, Math.floor(totalRuns)) : 0;
    const normalizedBatchSize = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;

    if (normalizedDataSize > 500_000) {
        return { useCache: true, reason: "large_dataset" };
    }

    const estimatedBatches = Math.ceil(normalizedTotalRuns / normalizedBatchSize);
    const minBatches = options?.minBatchesForCache ?? 8;
    if (estimatedBatches >= minBatches) {
        return { useCache: true, reason: "high_batch_count" };
    }

    return { useCache: false, reason: "none" };
}

export function compactSignalsForRust(signals: Signal[]): CompactSignal[] {
    for (const signal of signals) {
        // The compact shape is exactly {time, type, price, barIndex}. Any Signal
        // carrying one of the known optional fields below would ship extra bytes
        // to Rust, so we fall back to a cloned compact array. This is coupled to
        // the `Signal` interface — if a new non-compact optional field is added
        // there, add it to this check.
        if (
            signal.triggerPrice !== undefined
            || signal.reason !== undefined
            || signal.sizeFraction !== undefined
            || signal.exitOnly !== undefined
        ) {
            return cloneCompactSignals(signals);
        }
    }

    return signals as unknown as CompactSignal[];
}

function serializeCandidateParams(params: StrategyParams): string {
    const keys = Object.keys(params).sort();
    let serialized = "";
    for (let i = 0; i < keys.length; i++) {
        if (i > 0) serialized += "|";
        const key = keys[i];
        serialized += key;
        serialized += ":";
        serialized += params[key];
    }
    return serialized;
}

function cloneCompactSignals(signals: Signal[]): CompactSignal[] {
    return signals.map((signal) => ({
        time: signal.time,
        type: signal.type,
        price: signal.price,
        barIndex: signal.barIndex,
    }));
}

function clampPercentValue(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function clampMaxHoldBars(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(1, Math.round(value));
}

function clampAtrPeriod(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.round(value));
}

function usesPercentageTakeProfitMode(
    settings: BacktestSettings,
    mode: TakeProfitMode
): boolean {
    return settings.riskMode === "percentage"
        && settings.takeProfitEnabled === true
        && settings.takeProfitMode === mode;
}

function clampTakeProfitMfeBootstrapPercentile(value: number): number {
    return clampPercentValue(value, 1, 99);
}

function clampPathExitMinBars(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.round(value));
}

function clampPathExitMinSamples(value: number): number {
    if (!Number.isFinite(value)) return 5;
    return Math.max(5, Math.round(value));
}

function clampPathExitThreshold(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return clampPercentValue(value, 0, 100);
}

function defaultPathExitThreshold(settings: BacktestSettings): number {
    if (Number.isFinite(settings.pathExitThreshold) && Number(settings.pathExitThreshold) > 0) {
        return Number(settings.pathExitThreshold);
    }
    return settings.pathExitMode === "capitulation_exhaustion" ? 90 : 1;
}

const TP_PARAM_SPECS: readonly TpParamSpec[] = [
    { key: "takeProfitMfeBootstrapPercentile", mode: "mfe_bootstrap", clamp: clampTakeProfitMfeBootstrapPercentile },
    { key: "takeProfitAdaptiveLookbackTrades", mode: "expectancy_optimal", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveLookbackTrades", mode: "regime_calibrated", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveLookbackTrades", mode: "information_coefficient", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveLookbackTrades", mode: "path_efficiency", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveLookbackTrades", mode: "serial_dependency", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveLookbackTrades", mode: "minimum_surprisal", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveRecentWindow", mode: "serial_dependency", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveMinMultiplier", mode: "edge_weighted", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMinMultiplier", mode: "expectancy_optimal", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMinMultiplier", mode: "information_coefficient", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMinMultiplier", mode: "path_efficiency", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMinMultiplier", mode: "serial_dependency", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMinMultiplier", mode: "minimum_surprisal", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMaxMultiplier", mode: "edge_weighted", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMaxMultiplier", mode: "expectancy_optimal", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMaxMultiplier", mode: "information_coefficient", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMaxMultiplier", mode: "path_efficiency", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMaxMultiplier", mode: "serial_dependency", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveMaxMultiplier", mode: "minimum_surprisal", clamp: (value) => clampPercentValue(value, 0.1, 5) },
    { key: "takeProfitAdaptiveGridSteps", mode: "expectancy_optimal", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveGridSteps", mode: "regime_calibrated", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveGridSteps", mode: "minimum_surprisal", clamp: clampAtrPeriod },
    { key: "takeProfitAdaptiveRegimeBlend", mode: "regime_calibrated", clamp: (value) => clampPercentValue(value, 0, 1) },
    { key: "takeProfitAdaptiveIcScale", mode: "information_coefficient", clamp: (value) => clampPercentValue(value, 0, 2) },
];

const ALL_PATH_EXIT_MODES: readonly PathExitMode[] = [
    "mfe_giveback",
    "profit_compression",
    "momentum_deceleration",
    "capitulation_exhaustion",
    "squeeze_pressure",
    "structure_reclaim",
    "conditional_hazard",
    "triple_barrier_meta",
];

const PATH_EXIT_PARAM_SPECS: readonly PathExitParamSpec[] = [
    { key: "pathExitMinBars", modes: ALL_PATH_EXIT_MODES, clamp: clampPathExitMinBars },
    { key: "pathExitMinMfePercent", modes: ["mfe_giveback", "profit_compression"], clamp: (value) => clampPercentValue(value, 0, 100) },
    { key: "pathExitGivebackPercent", modes: ["mfe_giveback"], clamp: (value) => clampPercentValue(value, 1, 100) },
    { key: "pathExitLookbackBars", modes: ["momentum_deceleration", "capitulation_exhaustion", "squeeze_pressure", "structure_reclaim"], clamp: clampPathExitMinBars },
    { key: "pathExitThreshold", modes: ["profit_compression", "momentum_deceleration", "capitulation_exhaustion", "triple_barrier_meta"], value: defaultPathExitThreshold, clamp: clampPathExitThreshold },
    { key: "pathExitMinSamples", modes: ["conditional_hazard", "triple_barrier_meta"], clamp: clampPathExitMinSamples },
    { key: "pathExitHorizonBars", modes: ["triple_barrier_meta"], clamp: clampPathExitMinBars },
];

function addBaseParamIfFinite(
    baseParams: StrategyParams,
    key: keyof BacktestSettings & string,
    value: unknown,
    normalize: (value: number) => number
): void {
    if (!Number.isFinite(value)) return;
    baseParams[key] = normalize(Number(value));
}

function addModeSpecificTakeProfitSearchParams(baseParams: StrategyParams, settings: BacktestSettings): void {
    for (const spec of TP_PARAM_SPECS) {
        if (!spec.mode || !usesPercentageTakeProfitMode(settings, spec.mode)) {
            continue;
        }
        addBaseParamIfFinite(baseParams, spec.key, settings[spec.key], spec.clamp);
    }
}

function isActivePathExit(settings: BacktestSettings): settings is BacktestSettings & { pathExitMode: PathExitMode } {
    return settings.pathExitEnabled === true
        && settings.pathExitMode !== undefined
        && settings.pathExitMode !== "off";
}

function shouldRandomizePathExitParams(
    settings: BacktestSettings,
    options?: Pick<FinderOptions, "randomizePathExitParams">
): boolean {
    return options?.randomizePathExitParams === true && isActivePathExit(settings);
}

function addPathExitSearchParams(baseParams: StrategyParams, settings: BacktestSettings): void {
    if (!isActivePathExit(settings)) return;
    for (const spec of PATH_EXIT_PARAM_SPECS) {
        if (!spec.modes.includes(settings.pathExitMode)) {
            continue;
        }
        const value = spec.value ? spec.value(settings) : settings[spec.key];
        addBaseParamIfFinite(baseParams, spec.key, value, spec.clamp);
    }
}

function addBacktestOverrideIfFinite(
    overrides: Partial<BacktestSettings>,
    params: StrategyParams,
    key: keyof BacktestSettings & string,
    normalize: (value: number) => number
): boolean {
    const rawValue = params[key];
    if (!Number.isFinite(rawValue)) return false;
    (overrides as Record<string, number | undefined>)[key] = normalize(Number(rawValue));
    return true;
}

function applyModeSpecificTakeProfitOverrides(
    settings: BacktestSettings,
    params: StrategyParams,
    backtestOverrides: Partial<BacktestSettings>
): boolean {
    let hasOverrides = false;
    for (const spec of TP_PARAM_SPECS) {
        if (!spec.mode || !usesPercentageTakeProfitMode(settings, spec.mode)) {
            continue;
        }
        hasOverrides = addBacktestOverrideIfFinite(backtestOverrides, params, spec.key, spec.clamp) || hasOverrides;
    }
    return hasOverrides;
}

function applyPathExitOverrides(
    settings: BacktestSettings,
    params: StrategyParams,
    backtestOverrides: Partial<BacktestSettings>,
    options?: Pick<FinderOptions, "randomizePathExitParams">
): boolean {
    if (!shouldRandomizePathExitParams(settings, options)) {
        return false;
    }

    let hasOverrides = false;
    for (const spec of PATH_EXIT_PARAM_SPECS) {
        if (!isActivePathExit(settings) || !spec.modes.includes(settings.pathExitMode)) {
            continue;
        }
        hasOverrides = addBacktestOverrideIfFinite(backtestOverrides, params, spec.key, spec.clamp) || hasOverrides;
    }
    return hasOverrides;
}

function usesAtrRiskSettings(settings: BacktestSettings): boolean {
    if (settings.riskMode !== "simple") {
        return false;
    }

    return (
        Number(settings.stopLossAtr) > 0 ||
        Number(settings.takeProfitAtr) > 0 ||
        Number(settings.trailingAtr) > 0
    );
}

function isRiskManagementFrozen(options?: Pick<FinderOptions, "freezeRiskManagement">): boolean {
    return options?.freezeRiskManagement === true;
}

export function getFinderStrategyParamDefaults(strategy: Strategy): StrategyParams {
    const defaults: StrategyParams = { ...strategy.defaultParams };
    for (const key of strategy.finderFixedParams ?? []) {
        delete defaults[key];
    }
    return defaults;
}

export function buildFinderSearchBaseParams(
    strategy: Strategy,
    settings: BacktestSettings,
    options?: Pick<FinderOptions, "freezeRiskManagement" | "exitStrategyBaseParams" | "randomizePathExitParams">
): StrategyParams {
    const baseParams = getFinderStrategyParamDefaults(strategy);

    if (isRiskManagementFrozen(options)) {
        // Path-exit params are still searchable when Randomize Path Exits is on,
        // even under freeze. All other risk settings (ATR / SL / TP / max-hold)
        // remain frozen — only pathExit* params are added here.
        if (shouldRandomizePathExitParams(settings, options)) {
            addPathExitSearchParams(baseParams, settings);
        }
        return withExitStrategyBaseParams(baseParams, options?.exitStrategyBaseParams);
    }

    if (usesAtrRiskSettings(settings) && Number.isFinite(settings.atrPeriod)) {
        baseParams.atrPeriod = clampAtrPeriod(Number(settings.atrPeriod));
    }

    if (settings.riskMaxHoldEnabled && Number.isFinite(settings.riskMaxHoldBars)) {
        baseParams.riskMaxHoldBars = clampMaxHoldBars(Number(settings.riskMaxHoldBars));
    }

    if (shouldRandomizePathExitParams(settings, options)) {
        addPathExitSearchParams(baseParams, settings);
    }

    if (settings.riskMode !== "percentage") {
        return withExitStrategyBaseParams(baseParams, options?.exitStrategyBaseParams);
    }

    if (settings.stopLossEnabled && Number.isFinite(settings.stopLossPercent)) {
        baseParams.stopLossPercent = clampPercentValue(Number(settings.stopLossPercent), 0, 15);
    }
    if (settings.takeProfitEnabled && Number.isFinite(settings.takeProfitPercent)) {
        baseParams.takeProfitPercent = clampPercentValue(Number(settings.takeProfitPercent), 0, 100);
    }
    addModeSpecificTakeProfitSearchParams(baseParams, settings);
    return withExitStrategyBaseParams(baseParams, options?.exitStrategyBaseParams);
}

export function normalizeFinderCandidateParams(
    strategy: Strategy,
    params: StrategyParams,
    options?: { normalizeExitParams?: (exitParams: StrategyParams) => StrategyParams }
): StrategyParams {
    // Split off exit-strategy params first so the entry strategy's normalizer
    // never sees them (avoids accidental snapping of exit params onto entry grids).
    const { entryParams, exitParams } = splitExitStrategyParams(params);

    if (!strategy.normalizeParams) {
        const passthroughEntry: StrategyParams = { ...entryParams };
        const finalExitParams = options?.normalizeExitParams
            ? options.normalizeExitParams(exitParams)
            : exitParams;
        return { ...passthroughEntry, ...withExitStrategyBaseParams({}, finalExitParams) };
    }

    const strategyParamKeys = new Set(Object.keys(strategy.defaultParams));
    const strategyParams: StrategyParams = {};
    const passthroughParams: StrategyParams = {};

    for (const [key, value] of Object.entries(entryParams)) {
        if (strategyParamKeys.has(key)) {
            strategyParams[key] = value;
        } else {
            passthroughParams[key] = value;
        }
    }

    const normalizedStrategyParams = strategy.normalizeParams({
        ...strategy.defaultParams,
        ...strategyParams,
    });
    const finalExitParams = options?.normalizeExitParams
        ? options.normalizeExitParams(exitParams)
        : exitParams;
    return {
        ...normalizedStrategyParams,
        ...passthroughParams,
        ...withExitStrategyBaseParams({}, finalExitParams),
    };
}

export function normalizeFinderCandidateParamSets(
    strategy: Strategy,
    paramSets: StrategyParams[],
    options?: { normalizeExitParams?: (exitParams: StrategyParams) => StrategyParams }
): StrategyParams[] {
    if (paramSets.length === 1) {
        return [normalizeFinderCandidateParams(strategy, paramSets[0]!, options)];
    }
    const normalized: StrategyParams[] = [];
    const seen = new Set<string>();

    for (const params of paramSets) {
        const candidate = normalizeFinderCandidateParams(strategy, params, options);
        const key = serializeCandidateParams(candidate);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        normalized.push(candidate);
    }

    return normalized;
}

export function resolveFinderRiskOverrides(
    settings: BacktestSettings,
    rustSettings: BacktestSettings,
    params: StrategyParams,
    options?: Pick<FinderOptions, "freezeRiskManagement" | "randomizePathExitParams">
): { backtestSettings: BacktestSettings; rustBacktestSettings: BacktestSettings } {
    if (isRiskManagementFrozen(options)) {
        // Path-exit overrides still apply under freeze when Randomize Path Exits
        // is on (path exits force the TS engine, so only the backtest settings
        // need updating — not the rust mirror). All other risk settings stay frozen.
        if (shouldRandomizePathExitParams(settings, options)) {
            const backtestOverrides: Partial<BacktestSettings> = {};
            if (applyPathExitOverrides(settings, params, backtestOverrides, options)) {
                return {
                    backtestSettings: { ...settings, ...backtestOverrides },
                    rustBacktestSettings: rustSettings,
                };
            }
        }
        return {
            backtestSettings: settings,
            rustBacktestSettings: rustSettings,
        };
    }

    let hasBacktestOverrides = false;
    let hasRustOverrides = false;
    const backtestOverrides: Partial<BacktestSettings> = {};
    const rustOverrides: Partial<BacktestSettings> = {};

    if (usesAtrRiskSettings(settings) && Number.isFinite(params.atrPeriod)) {
        const normalized = clampAtrPeriod(Number(params.atrPeriod));
        backtestOverrides.atrPeriod = normalized;
        rustOverrides.atrPeriod = normalized;
        hasBacktestOverrides = true;
        hasRustOverrides = true;
    }

    if (settings.riskMaxHoldEnabled && Number.isFinite(params.riskMaxHoldBars)) {
        backtestOverrides.riskMaxHoldBars = clampMaxHoldBars(Number(params.riskMaxHoldBars));
        hasBacktestOverrides = true;
    }

    if (settings.riskMode !== "percentage") {
        hasBacktestOverrides = applyPathExitOverrides(settings, params, backtestOverrides, options) || hasBacktestOverrides;
        return {
            backtestSettings: hasBacktestOverrides ? { ...settings, ...backtestOverrides } : settings,
            rustBacktestSettings: hasRustOverrides ? { ...rustSettings, ...rustOverrides } : rustSettings,
        };
    }

    if (settings.stopLossEnabled && Number.isFinite(params.stopLossPercent)) {
        const normalized = clampPercentValue(Number(params.stopLossPercent), 0, 15);
        backtestOverrides.stopLossPercent = normalized;
        rustOverrides.stopLossPercent = normalized;
        hasBacktestOverrides = true;
        hasRustOverrides = true;
    }

    if (settings.takeProfitEnabled && Number.isFinite(params.takeProfitPercent)) {
        const normalized = clampPercentValue(Number(params.takeProfitPercent), 0, 100);
        backtestOverrides.takeProfitPercent = normalized;
        rustOverrides.takeProfitPercent = normalized;
        hasBacktestOverrides = true;
        hasRustOverrides = true;
    }

    hasBacktestOverrides = applyModeSpecificTakeProfitOverrides(settings, params, backtestOverrides) || hasBacktestOverrides;
    hasBacktestOverrides = applyPathExitOverrides(settings, params, backtestOverrides, options) || hasBacktestOverrides;

    return {
        backtestSettings: hasBacktestOverrides ? { ...settings, ...backtestOverrides } : settings,
        rustBacktestSettings: hasRustOverrides ? { ...rustSettings, ...rustOverrides } : rustSettings,
    };
}

export function mergeFinderRiskParamsIntoBacktestSettings<
    T extends BacktestSettings & { riskSettingsToggle?: boolean }
>(
    settings: T,
    params: StrategyParams,
    options?: Pick<FinderOptions, "freezeRiskManagement" | "randomizePathExitParams">
): T {
    const merged = { ...settings };
    if (isRiskManagementFrozen(options)) {
        // Apply path-exit params on Apply even under freeze when Randomize Path
        // Exits is on. Other risk settings stay frozen.
        if (shouldRandomizePathExitParams(settings, options)) {
            const mergedRecord = merged as unknown as Record<string, number | undefined>;
            for (const spec of PATH_EXIT_PARAM_SPECS) {
                if (!isActivePathExit(settings) || !spec.modes.includes(settings.pathExitMode)) {
                    continue;
                }
                const rawValue = params[spec.key];
                if (!Number.isFinite(rawValue)) {
                    continue;
                }
                mergedRecord[spec.key] = spec.clamp(Number(rawValue));
            }
        }
        return merged;
    }

    const mergedRecord = merged as unknown as Record<string, number | undefined>;
    const usesAtrRisk =
        settings.riskSettingsToggle === true
        && settings.riskMode === "simple";

    if (usesAtrRisk && Number.isFinite(params.atrPeriod)) {
        merged.atrPeriod = clampAtrPeriod(Number(params.atrPeriod));
    }

    if (Number.isFinite(params.stopLossPercent)) {
        merged.stopLossPercent = Number(params.stopLossPercent);
    }

    if (Number.isFinite(params.takeProfitPercent)) {
        merged.takeProfitPercent = Number(params.takeProfitPercent);
    }

    for (const spec of TP_PARAM_SPECS) {
        const rawValue = params[spec.key];
        if (!Number.isFinite(rawValue)) {
            continue;
        }
        mergedRecord[spec.key] = spec.clamp(Number(rawValue));
    }

    if (Number.isFinite(params.riskMaxHoldBars)) {
        merged.riskMaxHoldBars = Number(params.riskMaxHoldBars);
    }

    if (shouldRandomizePathExitParams(settings, options)) {
        for (const spec of PATH_EXIT_PARAM_SPECS) {
            if (!isActivePathExit(settings) || !spec.modes.includes(settings.pathExitMode)) {
                continue;
            }
            const rawValue = params[spec.key];
            if (!Number.isFinite(rawValue)) {
                continue;
            }
            mergedRecord[spec.key] = spec.clamp(Number(rawValue));
        }
    }

    return merged;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function coerceFiniteNumber(value: unknown, fallback = 0): number {
    if (isFiniteNumber(value)) return value;
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : fallback;
}

function normalizeRustBacktestResult(raw: unknown): BacktestResult | null {
    if (!raw || typeof raw !== "object") return null;
    const source = raw as Record<string, unknown>;
    const totalTrades = Math.max(0, Math.round(coerceFiniteNumber(source.totalTrades, 0)));
    const winningTrades = Math.max(0, Math.round(coerceFiniteNumber(source.winningTrades, 0)));
    const losingTrades = Math.max(0, Math.round(coerceFiniteNumber(source.losingTrades, 0)));
    if (!Number.isFinite(totalTrades) || !Number.isFinite(winningTrades) || !Number.isFinite(losingTrades)) {
        return null;
    }

    return {
        trades: (Array.isArray(source.trades) ? source.trades : []) as BacktestResult["trades"],
        netProfit: coerceFiniteNumber(source.netProfit, 0),
        netProfitPercent: coerceFiniteNumber(source.netProfitPercent, 0),
        winRate: coerceFiniteNumber(source.winRate, 0),
        expectancy: coerceFiniteNumber(source.expectancy, 0),
        avgTrade: coerceFiniteNumber(source.avgTrade, 0),
        profitFactor: coerceFiniteNumber(source.profitFactor, 0),
        maxDrawdown: coerceFiniteNumber(source.maxDrawdown, 0),
        maxDrawdownPercent: coerceFiniteNumber(source.maxDrawdownPercent, 0),
        totalTrades,
        winningTrades,
        losingTrades,
        avgWin: coerceFiniteNumber(source.avgWin, 0),
        avgLoss: coerceFiniteNumber(source.avgLoss, 0),
        sharpeRatio: coerceFiniteNumber(source.sharpeRatio, 0),
        equityCurve: (Array.isArray(source.equityCurve) ? source.equityCurve : []) as BacktestResult["equityCurve"],
    };
}

export function extractRustFinderCandidates(
    raw: unknown,
    strategyKey: string,
    strategyName: string,
    fallbackParams: StrategyParams
): RustFinderCandidatePayload[] {
    if (!Array.isArray(raw)) return [];
    const candidates: RustFinderCandidatePayload[] = [];

    for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const source = entry as Record<string, unknown>;
        const rawParams = (source.params ?? source.parameters ?? source.bestParams) as Record<string, unknown> | undefined;
        const normalizedParams: StrategyParams = {};
        if (rawParams && typeof rawParams === "object") {
            for (const [paramKey, value] of Object.entries(rawParams)) {
                const numeric = Number(value);
                if (Number.isFinite(numeric)) {
                    normalizedParams[paramKey] = numeric;
                }
            }
        }
        const params = Object.keys(normalizedParams).length > 0 ? normalizedParams : { ...fallbackParams };

        const rawResult = source.result ?? source.backtestResult ?? source.metrics ?? source;
        const normalizedResult = normalizeRustBacktestResult(rawResult);
        if (!normalizedResult) continue;

        candidates.push({
            key: strategyKey,
            name: strategyName,
            params,
            result: normalizedResult,
        });
    }

    return candidates;
}

export function selectPrescreenDataSlice(data: OHLCVData[]): OHLCVData[] {
    if (data.length <= 900) return data;
    const targetByRatio = Math.floor(data.length * 0.15);
    const targetLength = Math.min(Math.max(targetByRatio, 900), 4000);
    return data.slice(Math.max(0, data.length - targetLength));
}

export function resolveQuickFunnelShortlistCount(
    totalRuns: number,
    topN: number,
    options?: { rustStage?: boolean }
): number {
    if (totalRuns <= 180) return totalRuns;

    const rustStage = options?.rustStage === true;
    const ratio = rustStage
        ? (totalRuns >= 1200 ? 0.06 : totalRuns >= 600 ? 0.08 : 0.12)
        : (totalRuns >= 1200 ? 0.10 : totalRuns >= 600 ? 0.14 : 0.18);
    const ratioCount = Math.ceil(totalRuns * ratio);
    const absoluteFloor = rustStage ? Math.max(topN * 3, 16) : Math.max(topN * 5, 24);
    const absoluteCap = rustStage ? Math.max(topN * 6, 40) : Math.max(topN * 10, 80);

    return Math.max(1, Math.min(totalRuns, Math.min(absoluteCap, Math.max(ratioCount, absoluteFloor))));
}

export function buildComparableFinderResult(
    key: string,
    name: string,
    params: StrategyParams,
    result: BacktestResult
): FinderResult {
    return {
        key,
        name,
        params,
        result,
        selectionResult: result,
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
    };
}

export function finderSortRequiresCompositeEdgeRatio(sortPriority: FinderMetric[]): boolean {
    return sortPriority.includes("compositeEdgeRatio");
}

export function computeFinderCompositeEdgeRatio(result: BacktestResult, data: OHLCVData[]): number {
    if (!Array.isArray(result.trades) || result.trades.length === 0 || data.length === 0) {
        return 0;
    }

    try {
        return computeEdgeStatistics(result, data).compositeEdgeRatio;
    } catch {
        return 0;
    }
}

export function computeAverageCompositeEdgeRatio(entries: Array<{ result: BacktestResult; data: OHLCVData[] }>): number {
    const values = entries
        .map(({ result, data }) => computeFinderCompositeEdgeRatio(result, data))
        .filter((value) => Number.isFinite(value) && value > 0);

    if (values.length === 0) return 0;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.round(average * 10000) / 10000;
}

export function getPreparedFinderData(
    cache: FinderPreparedDataCache,
    strategyKey: string,
    strategy: Strategy,
    data: OHLCVData[],
    settings: BacktestSettings,
    executionContext?: import("../types/strategies").StrategyExecutionContext
): unknown {
    let byStrategy = cache.get(data);
    if (!byStrategy) {
        byStrategy = new Map<string, unknown>();
        cache.set(data, byStrategy);
    }
    const cacheParts = [strategyKey];
    if (executionContext?.crossSymbol) {
        cacheParts.push(`cross:${executionContext.crossSymbol.secondarySymbol}`);
    }
    if (executionContext?.polymarket1s) {
        cacheParts.push(`poly1s:${executionContext.polymarket1s.outcomeSymbol}:${executionContext.polymarket1s.seriesId}`);
    }
    const cacheKey = cacheParts.join("::");
    if (!byStrategy.has(cacheKey)) {
        byStrategy.set(cacheKey, strategy.prepareFinderData?.(data, settings, executionContext));
    }
    return byStrategy.get(cacheKey);
}
