import type {
    BacktestSettings,
    ExecutionModel,
    MarketMode,
    StrategyParams,
    TradeDirection,
    TradeFilterMode,
} from "./types/strategies";
import { getLegacyCompatibleTradeFilterModeValue } from "./legacy-settings-compat";

export const CAPITAL_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    fixedTradeAmount: 1000,
});

export const EFFECTIVE_BACKTEST_DEFAULTS = Object.freeze({
    atrPeriod: 14,
    stopLossAtr: 1.5,
    takeProfitAtr: 3,
    trailingAtr: 2,
    partialTakeProfitAtR: 1,
    partialTakeProfitPercent: 50,
    breakEvenAtR: 1,
    breakEvenPercent: 0,
    timeStopBars: 0,
    riskMode: "simple" as NonNullable<BacktestSettings["riskMode"]>,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    takeProfitMode: "fixed" as NonNullable<BacktestSettings["takeProfitMode"]>,
    takeProfitMfeLookbackTrades: 100,
    takeProfitMfePercentile: 60,
    takeProfitShrinkageStrength: 20,
    takeProfitMomentumRsiPeriod: 14,
    takeProfitMomentumRsiPauseLevel: 60,
    takeProfitMomentumDecayPercentPerBar: 0.15,
    takeProfitVelocityFastBars: 2,
    takeProfitVelocitySlowBars: 20,
    takeProfitVelocityProgressPercent: 50,
    takeProfitVelocityExpandMultiplier: 1.5,
    takeProfitVelocityShrinkMultiplier: 0.65,
    takeProfitAtrScaledMultiplier: 1.5,
    takeProfitRangeScaledLookback: 20,
    takeProfitRangeScaledFraction: 0.3,
    takeProfitMedianBarLookback: 20,
    takeProfitMedianBarMultiplier: 2,
    takeProfitMfeBootstrapPercentile: 60,
    stopLossEnabled: true,
    takeProfitEnabled: true,
    riskMaxHoldBars: 10,
    riskMaxHoldEnabled: false,
    riskWinStreakStopLossEnabled: false,
    riskWinStreakStopLossAfterWins: 3,
    riskWinStreakStopLossPercent: 0,
    marketMode: "all" as MarketMode,
    tradeFilterMode: "none" as TradeFilterMode,
    htfBiasEmaPeriod: 200,
    executionTrendEmaPeriod: 50,
    trendPersistenceWindow: 5,
    trendPersistenceMinBars: 4,
    trendSlopeLookback: 5,
    trendSlopeMinPercent: 0.2,
    confirmLookback: 1,
    volumeSmaPeriod: 20,
    volumeMultiplier: 1.5,
    rsiPeriod: 14,
    rsiBullish: 55,
    rsiBearish: 45,
    tradeDirection: "short" as TradeDirection,
    invertSignals: false,
    flipAfterConsecutiveLosses: 2,
    flipCooldownTrades: 0,
    minTradesBeforeFirstFlip: 0,
    executionModel: "next_open" as ExecutionModel,
    allowSameBarExit: false,
    slippageBps: 5,
    maxOpenTrades: 1,
    warmUpEntryEnabled: false,
    strategyTimeframeEnabled: false,
    strategyTimeframeMinutes: 120,
    twoHourCloseParity: "odd" as const,
});

export type SnapshotConfig = {
    toggleKey: string;
    minKey?: keyof BacktestSettings;
    maxKey: keyof BacktestSettings;
};

export const SNAPSHOT_CONFIGS: readonly SnapshotConfig[] = [
    { toggleKey: "snapshotAtrFilterToggle", minKey: "snapshotAtrPercentMin", maxKey: "snapshotAtrPercentMax" },
    { toggleKey: "snapshotVolumeFilterToggle", minKey: "snapshotVolumeRatioMin", maxKey: "snapshotVolumeRatioMax" },
    { toggleKey: "snapshotAdxFilterToggle", minKey: "snapshotAdxMin", maxKey: "snapshotAdxMax" },
    { toggleKey: "snapshotEmaFilterToggle", minKey: "snapshotEmaDistanceMin", maxKey: "snapshotEmaDistanceMax" },
    { toggleKey: "snapshotRsiFilterToggle", minKey: "snapshotRsiMin", maxKey: "snapshotRsiMax" },
    { toggleKey: "snapshotPriceRangePosFilterToggle", minKey: "snapshotPriceRangePosMin", maxKey: "snapshotPriceRangePosMax" },
    { toggleKey: "snapshotBarsFromHighFilterToggle", maxKey: "snapshotBarsFromHighMax" },
    { toggleKey: "snapshotBarsFromLowFilterToggle", maxKey: "snapshotBarsFromLowMax" },
    { toggleKey: "snapshotTrendEfficiencyFilterToggle", minKey: "snapshotTrendEfficiencyMin", maxKey: "snapshotTrendEfficiencyMax" },
    { toggleKey: "snapshotAtrRegimeFilterToggle", minKey: "snapshotAtrRegimeRatioMin", maxKey: "snapshotAtrRegimeRatioMax" },
    { toggleKey: "snapshotBodyPercentFilterToggle", minKey: "snapshotBodyPercentMin", maxKey: "snapshotBodyPercentMax" },
    { toggleKey: "snapshotWickSkewFilterToggle", minKey: "snapshotWickSkewMin", maxKey: "snapshotWickSkewMax" },
    { toggleKey: "snapshotVolumeTrendFilterToggle", minKey: "snapshotVolumeTrendMin", maxKey: "snapshotVolumeTrendMax" },
    { toggleKey: "snapshotVolumeBurstFilterToggle", minKey: "snapshotVolumeBurstMin", maxKey: "snapshotVolumeBurstMax" },
    { toggleKey: "snapshotVolumePriceDivergenceFilterToggle", minKey: "snapshotVolumePriceDivergenceMin", maxKey: "snapshotVolumePriceDivergenceMax" },
    { toggleKey: "snapshotVolumeConsistencyFilterToggle", minKey: "snapshotVolumeConsistencyMin", maxKey: "snapshotVolumeConsistencyMax" },
    { toggleKey: "snapshotCloseLocationFilterToggle", minKey: "snapshotCloseLocationMin", maxKey: "snapshotCloseLocationMax" },
    { toggleKey: "snapshotOppositeWickFilterToggle", minKey: "snapshotOppositeWickMin", maxKey: "snapshotOppositeWickMax" },
    { toggleKey: "snapshotRangeAtrFilterToggle", minKey: "snapshotRangeAtrMultipleMin", maxKey: "snapshotRangeAtrMultipleMax" },
    { toggleKey: "snapshotMomentumFilterToggle", minKey: "snapshotMomentumConsistencyMin", maxKey: "snapshotMomentumConsistencyMax" },
    { toggleKey: "snapshotBreakQualityFilterToggle", minKey: "snapshotBreakQualityMin", maxKey: "snapshotBreakQualityMax" },
    { toggleKey: "snapshotTf60PerfFilterToggle", minKey: "snapshotTf60PerfMin", maxKey: "snapshotTf60PerfMax" },
    { toggleKey: "snapshotTf90PerfFilterToggle", minKey: "snapshotTf90PerfMin", maxKey: "snapshotTf90PerfMax" },
    { toggleKey: "snapshotTf120PerfFilterToggle", minKey: "snapshotTf120PerfMin", maxKey: "snapshotTf120PerfMax" },
    { toggleKey: "snapshotTf480PerfFilterToggle", minKey: "snapshotTf480PerfMin", maxKey: "snapshotTf480PerfMax" },
    { toggleKey: "snapshotTfConfluencePerfFilterToggle", minKey: "snapshotTfConfluencePerfMin", maxKey: "snapshotTfConfluencePerfMax" },
    { toggleKey: "snapshotEntryQualityScoreFilterToggle", minKey: "snapshotEntryQualityScoreMin", maxKey: "snapshotEntryQualityScoreMax" },
];

export const BACKTEST_DOM_SETTING_IDS: readonly string[] = Object.freeze([
    "riskSettingsToggle",
    "tradeFilterSettingsToggle",
    "entrySettingsToggle",

    "riskMode",
    "atrPeriod",
    "stopLossAtr",
    "takeProfitAtr",
    "trailingAtr",
    "partialTakeProfitAtR",
    "partialTakeProfitPercent",
    "breakEvenAtR",
    "breakEvenPercent",
    "timeStopBars",
    "stopLossPercent",
    "takeProfitPercent",
    "takeProfitMode",
    "takeProfitMfeLookbackTrades",
    "takeProfitMfePercentile",
    "takeProfitShrinkageStrength",
    "takeProfitMomentumRsiPeriod",
    "takeProfitMomentumRsiPauseLevel",
    "takeProfitMomentumDecayPercentPerBar",
    "takeProfitVelocityFastBars",
    "takeProfitVelocitySlowBars",
    "takeProfitVelocityProgressPercent",
    "takeProfitVelocityExpandMultiplier",
    "takeProfitVelocityShrinkMultiplier",
    "takeProfitAtrScaledMultiplier",
    "takeProfitRangeScaledLookback",
    "takeProfitRangeScaledFraction",
    "takeProfitMedianBarLookback",
    "takeProfitMedianBarMultiplier",
    "takeProfitMfeBootstrapPercentile",
    "stopLossToggle",
    "takeProfitToggle",
    "riskMaxHoldBars",
    "riskMaxHoldToggle",
    "riskWinStreakStopLossToggle",
    "riskWinStreakStopLossAfterWins",
    "riskWinStreakStopLossPercent",
    "marketMode",
    "tradeFilterMode",
    "htfBiasEmaPeriod",
    "executionTrendEmaPeriod",
    "confirmLookback",
    "trendPersistenceWindow",
    "trendPersistenceMinBars",
    "trendSlopeLookback",
    "trendSlopeMinPercent",
    "volumeSmaPeriod",
    "volumeMultiplier",
    "confirmRsiPeriod",
    "confirmRsiBullish",
    "confirmRsiBearish",
    "tradeDirection",
    "invertSignalsToggle",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "executionModel",
    "allowSameBarExitToggle",
    "slippageBps",
    "maxOpenTrades",
    "warmUpEntryEnabled",
    "strategyTimeframeToggle",
    "strategyTimeframeMinutes",
    "twoHourCloseParity",
    ...SNAPSHOT_CONFIGS.flatMap(({ toggleKey, minKey, maxKey }) =>
        [toggleKey, minKey, maxKey].filter((key): key is string => Boolean(key))
    ),
]);

const VALID_TRADE_FILTER_MODES = new Set<TradeFilterMode>([
    "none",
    "close",
    "volume",
    "rsi",
    "trend",
    "adx",
    "htf_drift",
    "trend_htf_bias",
    "trend_exec_alignment",
    "trend_persistence",
    "trend_slope_strength",
    "trend_no_chase",
    "trend_hysteresis",
    "trend_mtf_stack",
]);
const VALID_TRADE_DIRECTIONS = new Set<TradeDirection>(["long", "short", "both", "both_flip_loss_2", "combined"]);
const VALID_TAKE_PROFIT_MODES = new Set<NonNullable<BacktestSettings["takeProfitMode"]>>([
    "fixed",
    "shrinkage",
    "momentum_gated",
    "velocity",
    "atr_scaled",
    "range_scaled",
    "median_bar",
    "mfe_bootstrap",
]);

function toBooleanLike(rawValue: unknown): boolean | null {
    if (typeof rawValue === "boolean") return rawValue;
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue !== 0;
    if (typeof rawValue !== "string") return null;

    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return null;
}

function toFiniteNumber(rawValue: unknown): number | null {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue;
    if (typeof rawValue !== "string") return null;

    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function coerceScalar(rawValue: unknown): unknown {
    const asBoolean = toBooleanLike(rawValue);
    if (asBoolean !== null) return asBoolean;
    const asNumber = toFiniteNumber(rawValue);
    if (asNumber !== null) return asNumber;
    return rawValue;
}

function coerceDeepValue(rawValue: unknown): unknown {
    if (Array.isArray(rawValue)) {
        return rawValue.map((value) => coerceDeepValue(value));
    }
    if (rawValue && typeof rawValue === "object") {
        const record = rawValue as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            normalized[key] = coerceDeepValue(value);
        }
        return normalized;
    }
    return coerceScalar(rawValue);
}

function readNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
    const parsed = toFiniteNumber(raw[key]);
    return parsed !== null ? parsed : fallback;
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const parsed = toBooleanLike(raw[key]);
    return parsed !== null ? parsed : fallback;
}

function readBooleanAny(raw: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
    for (const key of keys) {
        if (!(key in raw)) continue;
        const parsed = toBooleanLike(raw[key]);
        if (parsed !== null) return parsed;
    }
    return fallback;
}

function readTradeFilterMode(rawValue: unknown, fallback: TradeFilterMode): TradeFilterMode {
    if (typeof rawValue === "string") {
        const mode = rawValue.trim().toLowerCase() as TradeFilterMode;
        if (VALID_TRADE_FILTER_MODES.has(mode)) return mode;
    }
    return fallback;
}

function readTradeDirection(rawValue: unknown, fallback: TradeDirection): TradeDirection {
    if (typeof rawValue === "string") {
        const direction = rawValue.trim().toLowerCase() as TradeDirection;
        if (VALID_TRADE_DIRECTIONS.has(direction)) return direction;
    }
    return fallback;
}

function readStringArray(rawValue: unknown): string[] {
    if (!Array.isArray(rawValue)) return [];
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of rawValue) {
        if (typeof item !== "string") continue;
        const normalized = item.trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        items.push(normalized);
    }
    return items;
}

function readConfirmationStrategyParams(
    rawValue: unknown,
    allowedStrategies?: ReadonlySet<string>
): Record<string, StrategyParams> {
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) return {};

    const source = coerceDeepValue(rawValue);
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};

    const result: Record<string, StrategyParams> = {};
    for (const [strategyKey, strategyParamsRaw] of Object.entries(source as Record<string, unknown>)) {
        if (allowedStrategies && allowedStrategies.size > 0 && !allowedStrategies.has(strategyKey)) {
            continue;
        }
        if (!strategyParamsRaw || typeof strategyParamsRaw !== "object" || Array.isArray(strategyParamsRaw)) {
            continue;
        }

        const params: StrategyParams = {};
        for (const [paramKey, paramValue] of Object.entries(strategyParamsRaw as Record<string, unknown>)) {
            const parsed = toFiniteNumber(paramValue);
            if (parsed !== null) {
                params[paramKey] = parsed;
            }
        }
        result[strategyKey] = params;
    }

    return result;
}

function resolveSnapshotValue(raw: Record<string, unknown>, toggleKey: string, valueKey: string): number {
    return readBoolean(raw, toggleKey, false) ? readNumber(raw, valueKey, 0) : 0;
}

export function hasUiToggleSettings(raw: Record<string, unknown>): boolean {
    return [
        "riskSettingsToggle",
        "tradeFilterSettingsToggle",
        "entrySettingsToggle",
        "riskWinStreakStopLossToggle",
        "invertSignalsToggle",
        ...SNAPSHOT_CONFIGS.map((snapshot) => snapshot.toggleKey),
    ].some((key) => key in raw);
}

export function resolveBacktestSettingsFromRaw(
    settings?: BacktestSettings,
    options?: {
        captureSnapshots?: boolean;
        coerceWithoutUiToggles?: boolean;
    }
): BacktestSettings {
    if (!settings) return {};

    const raw = settings as Record<string, unknown>;
    if (options?.coerceWithoutUiToggles !== false && !hasUiToggleSettings(raw)) {
        return coerceDeepValue(settings) as BacktestSettings;
    }

    const riskEnabled = readBoolean(raw, "riskSettingsToggle", false);
    const riskModeRaw = raw["riskMode"];
    const riskMode: BacktestSettings["riskMode"] =
        riskModeRaw === "advanced" || riskModeRaw === "percentage"
            ? riskModeRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.riskMode;
    const useAtrRisk = riskEnabled && (riskMode === "simple" || riskMode === "advanced");
    const usePercentRisk = riskEnabled && riskMode === "percentage";
    const useAdvancedRisk = riskEnabled && riskMode === "advanced";
    const useRiskMaxHold = riskEnabled;

    const tradeFilterEnabled = readBoolean(
        raw,
        "tradeFilterSettingsToggle",
        readBoolean(raw, "entrySettingsToggle", false)
    );
    const tradeFilterMode = tradeFilterEnabled
        ? readTradeFilterMode(
            getLegacyCompatibleTradeFilterModeValue(raw),
            EFFECTIVE_BACKTEST_DEFAULTS.tradeFilterMode
        )
        : "none";
    const confirmationStrategiesEnabled = readBoolean(raw, "confirmationStrategiesToggle", false);
    const confirmationStrategies = confirmationStrategiesEnabled ? readStringArray(raw["confirmationStrategies"]) : [];
    const allowedConfirmationStrategies = new Set(confirmationStrategies);
    const confirmationStrategyParams = confirmationStrategiesEnabled
        ? readConfirmationStrategyParams(raw["confirmationStrategyParams"], allowedConfirmationStrategies)
        : {};



    const executionModelRaw = raw["executionModel"];
    const executionModel: ExecutionModel =
        executionModelRaw === "signal_close" || executionModelRaw === "next_open" || executionModelRaw === "next_close"
            ? executionModelRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
    const tradeDirection = readTradeDirection(raw["tradeDirection"], EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection);

    const marketModeRaw = raw["marketMode"];
    const marketMode: MarketMode =
        marketModeRaw === "uptrend" || marketModeRaw === "downtrend" || marketModeRaw === "sideway"
            ? marketModeRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.marketMode;
    const parityRaw = raw["twoHourCloseParity"];
    const twoHourCloseParity = parityRaw === "even" || parityRaw === "both" ? parityRaw : "odd";

    const resolved: BacktestSettings = {
        atrPeriod: readNumber(raw, "atrPeriod", EFFECTIVE_BACKTEST_DEFAULTS.atrPeriod),
        stopLossAtr: useAtrRisk ? readNumber(raw, "stopLossAtr", EFFECTIVE_BACKTEST_DEFAULTS.stopLossAtr) : 0,
        takeProfitAtr: useAtrRisk ? readNumber(raw, "takeProfitAtr", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtr) : 0,
        trailingAtr: useAtrRisk ? readNumber(raw, "trailingAtr", EFFECTIVE_BACKTEST_DEFAULTS.trailingAtr) : 0,
        partialTakeProfitAtR: useAdvancedRisk ? readNumber(raw, "partialTakeProfitAtR", EFFECTIVE_BACKTEST_DEFAULTS.partialTakeProfitAtR) : 0,
        partialTakeProfitPercent: useAdvancedRisk ? readNumber(raw, "partialTakeProfitPercent", EFFECTIVE_BACKTEST_DEFAULTS.partialTakeProfitPercent) : 0,
        breakEvenAtR: useAdvancedRisk ? readNumber(raw, "breakEvenAtR", EFFECTIVE_BACKTEST_DEFAULTS.breakEvenAtR) : 0,
        breakEvenPercent: usePercentRisk ? readNumber(raw, "breakEvenPercent", EFFECTIVE_BACKTEST_DEFAULTS.breakEvenPercent) : 0,
        timeStopBars: useAdvancedRisk ? readNumber(raw, "timeStopBars", EFFECTIVE_BACKTEST_DEFAULTS.timeStopBars) : 0,
        riskMode,
        stopLossPercent: usePercentRisk ? readNumber(raw, "stopLossPercent", EFFECTIVE_BACKTEST_DEFAULTS.stopLossPercent) : 0,
        takeProfitPercent: usePercentRisk ? readNumber(raw, "takeProfitPercent", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitPercent) : 0,
        takeProfitMode: usePercentRisk && typeof raw["takeProfitMode"] === "string" && VALID_TAKE_PROFIT_MODES.has(raw["takeProfitMode"] as NonNullable<BacktestSettings["takeProfitMode"]>)
            ? raw["takeProfitMode"] as NonNullable<BacktestSettings["takeProfitMode"]>
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMode,
        takeProfitMfeLookbackTrades: usePercentRisk
            ? Math.max(5, Math.round(readNumber(raw, "takeProfitMfeLookbackTrades", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeLookbackTrades)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeLookbackTrades,
        takeProfitMfePercentile: usePercentRisk
            ? Math.max(1, Math.min(99, readNumber(raw, "takeProfitMfePercentile", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfePercentile)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfePercentile,
        takeProfitShrinkageStrength: usePercentRisk
            ? Math.max(1, readNumber(raw, "takeProfitShrinkageStrength", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitShrinkageStrength))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitShrinkageStrength,
        takeProfitMomentumRsiPeriod: usePercentRisk
            ? Math.max(2, Math.round(readNumber(raw, "takeProfitMomentumRsiPeriod", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumRsiPeriod)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumRsiPeriod,
        takeProfitMomentumRsiPauseLevel: usePercentRisk
            ? Math.max(1, Math.min(99, readNumber(raw, "takeProfitMomentumRsiPauseLevel", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumRsiPauseLevel)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumRsiPauseLevel,
        takeProfitMomentumDecayPercentPerBar: usePercentRisk
            ? Math.max(0, readNumber(raw, "takeProfitMomentumDecayPercentPerBar", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumDecayPercentPerBar))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMomentumDecayPercentPerBar,
        takeProfitVelocityFastBars: usePercentRisk
            ? Math.max(1, Math.round(readNumber(raw, "takeProfitVelocityFastBars", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityFastBars)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityFastBars,
        takeProfitVelocitySlowBars: usePercentRisk
            ? Math.max(1, Math.round(readNumber(raw, "takeProfitVelocitySlowBars", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocitySlowBars)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocitySlowBars,
        takeProfitVelocityProgressPercent: usePercentRisk
            ? Math.max(1, Math.min(100, readNumber(raw, "takeProfitVelocityProgressPercent", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityProgressPercent)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityProgressPercent,
        takeProfitVelocityExpandMultiplier: usePercentRisk
            ? Math.max(0.1, readNumber(raw, "takeProfitVelocityExpandMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityExpandMultiplier))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityExpandMultiplier,
        takeProfitVelocityShrinkMultiplier: usePercentRisk
            ? Math.max(0.1, readNumber(raw, "takeProfitVelocityShrinkMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityShrinkMultiplier))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitVelocityShrinkMultiplier,
        takeProfitAtrScaledMultiplier: usePercentRisk
            ? Math.max(0.1, readNumber(raw, "takeProfitAtrScaledMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtrScaledMultiplier))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtrScaledMultiplier,
        takeProfitRangeScaledLookback: usePercentRisk
            ? Math.max(5, Math.round(readNumber(raw, "takeProfitRangeScaledLookback", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitRangeScaledLookback)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitRangeScaledLookback,
        takeProfitRangeScaledFraction: usePercentRisk
            ? Math.max(0.01, Math.min(1, readNumber(raw, "takeProfitRangeScaledFraction", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitRangeScaledFraction)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitRangeScaledFraction,
        takeProfitMedianBarLookback: usePercentRisk
            ? Math.max(5, Math.round(readNumber(raw, "takeProfitMedianBarLookback", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMedianBarLookback)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMedianBarLookback,
        takeProfitMedianBarMultiplier: usePercentRisk
            ? Math.max(0.1, readNumber(raw, "takeProfitMedianBarMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMedianBarMultiplier))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMedianBarMultiplier,
        takeProfitMfeBootstrapPercentile: usePercentRisk
            ? Math.max(1, Math.min(99, readNumber(raw, "takeProfitMfeBootstrapPercentile", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeBootstrapPercentile)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeBootstrapPercentile,
        stopLossEnabled: usePercentRisk ? readBooleanAny(raw, ["stopLossEnabled", "stopLossToggle"], EFFECTIVE_BACKTEST_DEFAULTS.stopLossEnabled) : false,
        takeProfitEnabled: usePercentRisk ? readBooleanAny(raw, ["takeProfitEnabled", "takeProfitToggle"], EFFECTIVE_BACKTEST_DEFAULTS.takeProfitEnabled) : false,
        riskMaxHoldBars: useRiskMaxHold ? readNumber(raw, "riskMaxHoldBars", EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldBars) : 0,
        riskMaxHoldEnabled: useRiskMaxHold ? readBooleanAny(raw, ["riskMaxHoldEnabled", "riskMaxHoldToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldEnabled) : false,
        riskWinStreakStopLossEnabled: usePercentRisk
            ? readBooleanAny(raw, ["riskWinStreakStopLossEnabled", "riskWinStreakStopLossToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossEnabled)
            : false,
        riskWinStreakStopLossAfterWins: usePercentRisk
            ? Math.max(1, Math.round(readNumber(raw, "riskWinStreakStopLossAfterWins", EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossAfterWins)))
            : EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossAfterWins,
        riskWinStreakStopLossPercent: usePercentRisk
            ? Math.max(0, readNumber(raw, "riskWinStreakStopLossPercent", EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossPercent))
            : 0,
        marketMode,
        trendEmaPeriod: 0,
        trendEmaSlopeBars: 0,
        atrPercentMin: 0,
        atrPercentMax: 0,
        adxPeriod: 14,
        adxMin: 0,
        adxMax: 0,
        tradeFilterMode,
        confirmationStrategies,
        confirmationStrategyParams,

        htfBiasEmaPeriod: tradeFilterEnabled
            ? readNumber(raw, "htfBiasEmaPeriod", EFFECTIVE_BACKTEST_DEFAULTS.htfBiasEmaPeriod)
            : EFFECTIVE_BACKTEST_DEFAULTS.htfBiasEmaPeriod,
        executionTrendEmaPeriod: tradeFilterEnabled
            ? readNumber(raw, "executionTrendEmaPeriod", EFFECTIVE_BACKTEST_DEFAULTS.executionTrendEmaPeriod)
            : EFFECTIVE_BACKTEST_DEFAULTS.executionTrendEmaPeriod,
        confirmLookback: tradeFilterEnabled ? readNumber(raw, "confirmLookback", EFFECTIVE_BACKTEST_DEFAULTS.confirmLookback) : EFFECTIVE_BACKTEST_DEFAULTS.confirmLookback,
        trendPersistenceWindow: tradeFilterEnabled
            ? readNumber(raw, "trendPersistenceWindow", EFFECTIVE_BACKTEST_DEFAULTS.trendPersistenceWindow)
            : EFFECTIVE_BACKTEST_DEFAULTS.trendPersistenceWindow,
        trendPersistenceMinBars: tradeFilterEnabled
            ? readNumber(raw, "trendPersistenceMinBars", EFFECTIVE_BACKTEST_DEFAULTS.trendPersistenceMinBars)
            : EFFECTIVE_BACKTEST_DEFAULTS.trendPersistenceMinBars,
        trendSlopeLookback: tradeFilterEnabled
            ? readNumber(raw, "trendSlopeLookback", EFFECTIVE_BACKTEST_DEFAULTS.trendSlopeLookback)
            : EFFECTIVE_BACKTEST_DEFAULTS.trendSlopeLookback,
        trendSlopeMinPercent: tradeFilterEnabled
            ? readNumber(raw, "trendSlopeMinPercent", EFFECTIVE_BACKTEST_DEFAULTS.trendSlopeMinPercent)
            : EFFECTIVE_BACKTEST_DEFAULTS.trendSlopeMinPercent,
        volumeSmaPeriod: tradeFilterEnabled ? readNumber(raw, "volumeSmaPeriod", EFFECTIVE_BACKTEST_DEFAULTS.volumeSmaPeriod) : EFFECTIVE_BACKTEST_DEFAULTS.volumeSmaPeriod,
        volumeMultiplier: tradeFilterEnabled ? readNumber(raw, "volumeMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.volumeMultiplier) : EFFECTIVE_BACKTEST_DEFAULTS.volumeMultiplier,
        rsiPeriod: tradeFilterEnabled
            ? readNumber(raw, "rsiPeriod", readNumber(raw, "confirmRsiPeriod", EFFECTIVE_BACKTEST_DEFAULTS.rsiPeriod))
            : EFFECTIVE_BACKTEST_DEFAULTS.rsiPeriod,
        rsiBullish: tradeFilterEnabled
            ? readNumber(raw, "rsiBullish", readNumber(raw, "confirmRsiBullish", EFFECTIVE_BACKTEST_DEFAULTS.rsiBullish))
            : EFFECTIVE_BACKTEST_DEFAULTS.rsiBullish,
        rsiBearish: tradeFilterEnabled
            ? readNumber(raw, "rsiBearish", readNumber(raw, "confirmRsiBearish", EFFECTIVE_BACKTEST_DEFAULTS.rsiBearish))
            : EFFECTIVE_BACKTEST_DEFAULTS.rsiBearish,

        tradeDirection,
        invertSignals: readBooleanAny(raw, ["invertSignals", "invertSignalsToggle"], EFFECTIVE_BACKTEST_DEFAULTS.invertSignals),
        flipAfterConsecutiveLosses: readNumber(raw, "flipAfterConsecutiveLosses", EFFECTIVE_BACKTEST_DEFAULTS.flipAfterConsecutiveLosses),
        flipCooldownTrades: readNumber(raw, "flipCooldownTrades", EFFECTIVE_BACKTEST_DEFAULTS.flipCooldownTrades),
        minTradesBeforeFirstFlip: readNumber(raw, "minTradesBeforeFirstFlip", EFFECTIVE_BACKTEST_DEFAULTS.minTradesBeforeFirstFlip),
        executionModel,
        allowSameBarExit: readBooleanAny(raw, ["allowSameBarExit", "allowSameBarExitToggle"], EFFECTIVE_BACKTEST_DEFAULTS.allowSameBarExit),
        slippageBps: readNumber(raw, "slippageBps", EFFECTIVE_BACKTEST_DEFAULTS.slippageBps),
        maxOpenTrades: Math.max(1, Math.min(2, Math.round(readNumber(raw, "maxOpenTrades", EFFECTIVE_BACKTEST_DEFAULTS.maxOpenTrades)))),
        warmUpEntryEnabled: readBooleanAny(raw, ["warmUpEntryEnabled", "warmUpEntryToggle"], EFFECTIVE_BACKTEST_DEFAULTS.warmUpEntryEnabled),
        strategyTimeframeEnabled: readBooleanAny(raw, ["strategyTimeframeEnabled", "strategyTimeframeToggle"], EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeEnabled),
        strategyTimeframeMinutes: readNumber(raw, "strategyTimeframeMinutes", EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeMinutes),
        captureSnapshots: options?.captureSnapshots ?? false,
        twoHourCloseParity,
    };

    for (const snapshot of SNAPSHOT_CONFIGS) {
        if (snapshot.minKey) {
            (resolved as Record<string, number>)[snapshot.minKey] = resolveSnapshotValue(raw, snapshot.toggleKey, snapshot.minKey);
        }
        if (snapshot.maxKey) {
            (resolved as Record<string, number>)[snapshot.maxKey] = resolveSnapshotValue(raw, snapshot.toggleKey, snapshot.maxKey);
        }
    }

    return resolved;
}
