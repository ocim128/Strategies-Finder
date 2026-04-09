import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
} from "../strategies";
import { computeEdgeStatistics } from "../strategies/backtest/edge-statistics";
import type { FinderMetric, FinderOptions, FinderResult } from "../types/finder";

export type FinderPreparedDataCache = WeakMap<OHLCVData[], Map<string, unknown>>;

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

type TpParamSpec = {
    key: keyof BacktestSettings & string;
    mode?: TakeProfitMode;
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

function usesAtrRiskSettings(settings: BacktestSettings): boolean {
    if (settings.riskMode !== "simple" && settings.riskMode !== "advanced") {
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

export function buildFinderSearchBaseParams(
    strategy: Strategy,
    settings: BacktestSettings,
    options?: Pick<FinderOptions, "freezeRiskManagement">
): StrategyParams {
    const baseParams: StrategyParams = { ...strategy.defaultParams };
    if (isRiskManagementFrozen(options)) {
        return baseParams;
    }

    if (usesAtrRiskSettings(settings) && Number.isFinite(settings.atrPeriod)) {
        baseParams.atrPeriod = clampAtrPeriod(Number(settings.atrPeriod));
    }

    if (settings.riskMaxHoldEnabled && Number.isFinite(settings.riskMaxHoldBars)) {
        baseParams.riskMaxHoldBars = clampMaxHoldBars(Number(settings.riskMaxHoldBars));
    }

    if (settings.riskMode !== "percentage") {
        return baseParams;
    }

    if (settings.stopLossEnabled && Number.isFinite(settings.stopLossPercent)) {
        baseParams.stopLossPercent = clampPercentValue(Number(settings.stopLossPercent), 0, 15);
    }
    if (settings.takeProfitEnabled && Number.isFinite(settings.takeProfitPercent)) {
        baseParams.takeProfitPercent = clampPercentValue(Number(settings.takeProfitPercent), 0, 100);
    }
    addModeSpecificTakeProfitSearchParams(baseParams, settings);
    return baseParams;
}

export function resolveFinderRiskOverrides(
    settings: BacktestSettings,
    rustSettings: BacktestSettings,
    params: StrategyParams,
    options?: Pick<FinderOptions, "freezeRiskManagement">
): { backtestSettings: BacktestSettings; rustBacktestSettings: BacktestSettings } {
    if (isRiskManagementFrozen(options)) {
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
    options?: Pick<FinderOptions, "freezeRiskManagement">
): T {
    const merged = { ...settings };
    if (isRiskManagementFrozen(options)) {
        return merged;
    }

    const mergedRecord = merged as unknown as Record<string, number | undefined>;
    const usesAtrRisk =
        settings.riskSettingsToggle === true
        && (settings.riskMode === "simple" || settings.riskMode === "advanced");

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

    if (Number.isFinite(params.riskWinStreakStopLossAfterWins)) {
        merged.riskWinStreakStopLossAfterWins = Number(params.riskWinStreakStopLossAfterWins);
    }

    if (Number.isFinite(params.riskWinStreakStopLossPercent)) {
        merged.riskWinStreakStopLossPercent = Number(params.riskWinStreakStopLossPercent);
    }

    return merged;
}

export function resolveFinderCandidateBacktestSettings(
    candidateBacktestSettings: BacktestSettings,
    comboPrimarySettings?: BacktestSettings
): BacktestSettings {
    return comboPrimarySettings ?? candidateBacktestSettings;
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

export function buildRustFinderBaseParams(
    strategy: Strategy,
    settings: BacktestSettings,
    options?: Pick<FinderOptions, "freezeRiskManagement">
): StrategyParams {
    return buildFinderSearchBaseParams(strategy, settings, options);
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
    settings: BacktestSettings
): unknown {
    let byStrategy = cache.get(data);
    if (!byStrategy) {
        byStrategy = new Map<string, unknown>();
        cache.set(data, byStrategy);
    }
    if (!byStrategy.has(strategyKey)) {
        byStrategy.set(strategyKey, strategy.prepareFinderData?.(data, settings));
    }
    return byStrategy.get(strategyKey);
}
