import type {
    BacktestSettings,
    ExecutionModel,
    MarketMode,
    StrategyParams,
    TradeDirection,
    TradeFilterMode,
} from "./types/strategies";
import { getLegacyCompatibleTradeFilterModeValue } from "./legacy-settings-compat";
import {
    readBoolean as readBooleanValue,
    readNumber as readNumberValue,
    toBooleanLike,
    toFiniteNumber,
} from "./settings-parse-utils";
import { ADAPTIVE_TAKE_PROFIT_DEFAULTS, resolveTakeProfitMode } from "./take-profit-settings";

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
    takeProfitMfeBootstrapPercentile: 60,
    takeProfitAdaptiveLookbackTrades: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveLookbackTrades,
    takeProfitAdaptiveRecentWindow: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveRecentWindow,
    takeProfitAdaptiveMinMultiplier: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveMinMultiplier,
    takeProfitAdaptiveMaxMultiplier: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveMaxMultiplier,
    takeProfitAdaptiveGridSteps: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveGridSteps,
    takeProfitAdaptiveRegimeBlend: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveRegimeBlend,
    takeProfitAdaptiveIcScale: ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveIcScale,
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
    strategyTimeframeEnabled: false,
    strategyTimeframeMinutes: 120,
    polymarketAnnotationEnabled: false,
    polymarketOutcomeSymbol: "",
    polymarketEntryOffset: 0,
    polymarketExitMode: "resolve_hold" as const,
    crossSymbolSecondary: "",
});

type ResolverGuardName =
    | "useAtrRisk"
    | "usePercentRisk"
    | "useAdvancedRisk"
    | "useRiskMaxHold"
    | "tradeFilterEnabled";

type ResolverGuardState = Record<ResolverGuardName, boolean>;

type NumericResolverKey =
    | "atrPeriod"
    | "stopLossAtr"
    | "takeProfitAtr"
    | "trailingAtr"
    | "partialTakeProfitAtR"
    | "partialTakeProfitPercent"
    | "breakEvenAtR"
    | "breakEvenPercent"
    | "timeStopBars"
    | "stopLossPercent"
    | "takeProfitPercent"
    | "takeProfitMfeBootstrapPercentile"
    | "takeProfitAdaptiveLookbackTrades"
    | "takeProfitAdaptiveRecentWindow"
    | "takeProfitAdaptiveMinMultiplier"
    | "takeProfitAdaptiveMaxMultiplier"
    | "takeProfitAdaptiveGridSteps"
    | "takeProfitAdaptiveRegimeBlend"
    | "takeProfitAdaptiveIcScale"
    | "riskMaxHoldBars"
    | "riskWinStreakStopLossAfterWins"
    | "riskWinStreakStopLossPercent"
    | "htfBiasEmaPeriod"
    | "executionTrendEmaPeriod"
    | "confirmLookback"
    | "volumeSmaPeriod"
    | "volumeMultiplier"
    | "rsiPeriod"
    | "rsiBullish"
    | "rsiBearish"
    | "flipAfterConsecutiveLosses"
    | "flipCooldownTrades"
    | "minTradesBeforeFirstFlip"
    | "slippageBps"
    | "maxOpenTrades"
    | "strategyTimeframeMinutes";

type BooleanResolverKey =
    | "stopLossEnabled"
    | "takeProfitEnabled"
    | "riskMaxHoldEnabled"
    | "riskWinStreakStopLossEnabled"
    | "invertSignals"
    | "allowSameBarExit"
    | "strategyTimeframeEnabled";

type NumericResolverRule = {
    key: NumericResolverKey;
    guard?: ResolverGuardName;
    disabledValue?: number;
    resolve?: (raw: Record<string, unknown>) => number;
};

type BooleanResolverRule = {
    key: BooleanResolverKey;
    keys?: readonly string[];
    guard?: ResolverGuardName;
    disabledValue?: boolean;
};

function readDefaultedNumber(raw: Record<string, unknown>, key: NumericResolverKey): number {
    return readNumber(raw, key, EFFECTIVE_BACKTEST_DEFAULTS[key] as number);
}

const NUMERIC_RESOLVER_RULES: readonly NumericResolverRule[] = [
    { key: "atrPeriod" },
    { key: "stopLossAtr", guard: "useAtrRisk", disabledValue: 0 },
    { key: "takeProfitAtr", guard: "useAtrRisk", disabledValue: 0 },
    { key: "trailingAtr", guard: "useAtrRisk", disabledValue: 0 },
    { key: "partialTakeProfitAtR", guard: "useAdvancedRisk", disabledValue: 0 },
    { key: "partialTakeProfitPercent", guard: "useAdvancedRisk", disabledValue: 0 },
    { key: "breakEvenAtR", guard: "useAdvancedRisk", disabledValue: 0 },
    { key: "breakEvenPercent", guard: "usePercentRisk", disabledValue: 0 },
    { key: "timeStopBars", guard: "useAdvancedRisk", disabledValue: 0 },
    { key: "stopLossPercent", guard: "usePercentRisk", disabledValue: 0 },
    { key: "takeProfitPercent", guard: "usePercentRisk", disabledValue: 0 },
    {
        key: "takeProfitMfeBootstrapPercentile",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(1, Math.min(99, readDefaultedNumber(raw, "takeProfitMfeBootstrapPercentile"))),
    },
    {
        key: "takeProfitAdaptiveLookbackTrades",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(5, Math.round(readDefaultedNumber(raw, "takeProfitAdaptiveLookbackTrades"))),
    },
    {
        key: "takeProfitAdaptiveRecentWindow",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(3, Math.round(readDefaultedNumber(raw, "takeProfitAdaptiveRecentWindow"))),
    },
    {
        key: "takeProfitAdaptiveMinMultiplier",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(0.1, readDefaultedNumber(raw, "takeProfitAdaptiveMinMultiplier")),
    },
    {
        key: "takeProfitAdaptiveMaxMultiplier",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(0.2, readDefaultedNumber(raw, "takeProfitAdaptiveMaxMultiplier")),
    },
    {
        key: "takeProfitAdaptiveGridSteps",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(3, Math.round(readDefaultedNumber(raw, "takeProfitAdaptiveGridSteps"))),
    },
    {
        key: "takeProfitAdaptiveRegimeBlend",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(0, Math.min(1, readDefaultedNumber(raw, "takeProfitAdaptiveRegimeBlend"))),
    },
    {
        key: "takeProfitAdaptiveIcScale",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(0, Math.min(2, readDefaultedNumber(raw, "takeProfitAdaptiveIcScale"))),
    },
    { key: "riskMaxHoldBars", guard: "useRiskMaxHold", disabledValue: 0 },
    {
        key: "riskWinStreakStopLossAfterWins",
        guard: "usePercentRisk",
        resolve: (raw) => Math.max(1, Math.round(readDefaultedNumber(raw, "riskWinStreakStopLossAfterWins"))),
    },
    {
        key: "riskWinStreakStopLossPercent",
        guard: "usePercentRisk",
        disabledValue: 0,
        resolve: (raw) => Math.max(0, readDefaultedNumber(raw, "riskWinStreakStopLossPercent")),
    },
    { key: "htfBiasEmaPeriod", guard: "tradeFilterEnabled" },
    { key: "executionTrendEmaPeriod", guard: "tradeFilterEnabled" },
    { key: "confirmLookback", guard: "tradeFilterEnabled" },
    { key: "volumeSmaPeriod", guard: "tradeFilterEnabled" },
    { key: "volumeMultiplier", guard: "tradeFilterEnabled" },
    {
        key: "rsiPeriod",
        guard: "tradeFilterEnabled",
        resolve: (raw) => readNumber(raw, "rsiPeriod", readNumber(raw, "confirmRsiPeriod", EFFECTIVE_BACKTEST_DEFAULTS.rsiPeriod)),
    },
    {
        key: "rsiBullish",
        guard: "tradeFilterEnabled",
        resolve: (raw) => readNumber(raw, "rsiBullish", readNumber(raw, "confirmRsiBullish", EFFECTIVE_BACKTEST_DEFAULTS.rsiBullish)),
    },
    {
        key: "rsiBearish",
        guard: "tradeFilterEnabled",
        resolve: (raw) => readNumber(raw, "rsiBearish", readNumber(raw, "confirmRsiBearish", EFFECTIVE_BACKTEST_DEFAULTS.rsiBearish)),
    },
    { key: "flipAfterConsecutiveLosses" },
    { key: "flipCooldownTrades" },
    { key: "minTradesBeforeFirstFlip" },
    { key: "slippageBps" },
    {
        key: "maxOpenTrades",
        resolve: (raw) => Math.max(1, Math.min(2, Math.round(readDefaultedNumber(raw, "maxOpenTrades")))),
    },
    { key: "strategyTimeframeMinutes" },
] as const;

const BOOLEAN_RESOLVER_RULES: readonly BooleanResolverRule[] = [
    { key: "stopLossEnabled", keys: ["stopLossEnabled", "stopLossToggle"], guard: "usePercentRisk", disabledValue: false },
    { key: "takeProfitEnabled", keys: ["takeProfitEnabled", "takeProfitToggle"], guard: "usePercentRisk", disabledValue: false },
    { key: "riskMaxHoldEnabled", keys: ["riskMaxHoldEnabled", "riskMaxHoldToggle"], guard: "useRiskMaxHold", disabledValue: false },
    {
        key: "riskWinStreakStopLossEnabled",
        keys: ["riskWinStreakStopLossEnabled", "riskWinStreakStopLossToggle"],
        guard: "usePercentRisk",
        disabledValue: false,
    },
    { key: "invertSignals", keys: ["invertSignals", "invertSignalsToggle"] },
    { key: "allowSameBarExit", keys: ["allowSameBarExit", "allowSameBarExitToggle"] },
    { key: "strategyTimeframeEnabled", keys: ["strategyTimeframeEnabled", "strategyTimeframeToggle"] },
] as const;

function resolveNumericSettingRules(
    raw: Record<string, unknown>,
    guards: ResolverGuardState
): Record<NumericResolverKey, number> {
    const resolved = {} as Record<NumericResolverKey, number>;
    for (const rule of NUMERIC_RESOLVER_RULES) {
        if (rule.guard && !guards[rule.guard]) {
            resolved[rule.key] = rule.disabledValue ?? (EFFECTIVE_BACKTEST_DEFAULTS[rule.key] as number);
            continue;
        }
        resolved[rule.key] = rule.resolve
            ? rule.resolve(raw)
            : readDefaultedNumber(raw, rule.key);
    }
    return resolved;
}

function resolveBooleanSettingRules(
    raw: Record<string, unknown>,
    guards: ResolverGuardState
): Record<BooleanResolverKey, boolean> {
    const resolved = {} as Record<BooleanResolverKey, boolean>;
    for (const rule of BOOLEAN_RESOLVER_RULES) {
        if (rule.guard && !guards[rule.guard]) {
            resolved[rule.key] = rule.disabledValue ?? (EFFECTIVE_BACKTEST_DEFAULTS[rule.key] as boolean);
            continue;
        }
        const fallback = EFFECTIVE_BACKTEST_DEFAULTS[rule.key] as boolean;
        const keys = rule.keys ?? [rule.key];
        resolved[rule.key] = keys.length === 1
            ? readBoolean(raw, keys[0], fallback)
            : readBooleanAny(raw, [...keys], fallback);
    }
    return resolved;
}

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
    "takeProfitMfeBootstrapPercentile",
    "takeProfitAdaptiveLookbackTrades",
    "takeProfitAdaptiveRecentWindow",
    "takeProfitAdaptiveMinMultiplier",
    "takeProfitAdaptiveMaxMultiplier",
    "takeProfitAdaptiveGridSteps",
    "takeProfitAdaptiveRegimeBlend",
    "takeProfitAdaptiveIcScale",
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
    "strategyTimeframeToggle",
    "strategyTimeframeMinutes",
    "polymarketAnnotationEnabled",
    "polymarketOutcomeSymbol",
    "polymarketEntryOffset",
    "polymarketExitMode",
    "crossSymbolSecondary",
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
]);
const VALID_TRADE_DIRECTIONS = new Set<TradeDirection>(["long", "short", "both", "both_flip_loss_2", "combined"]);
function coerceScalar(rawValue: unknown): unknown {
    if (typeof rawValue === "boolean") return rawValue;
    if (typeof rawValue === "number") return Number.isFinite(rawValue) ? rawValue : rawValue;
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
    return readNumberValue(raw[key], fallback);
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    return readBooleanValue(raw[key], fallback);
}

function readString(raw: Record<string, unknown>, key: string, fallback: string): string {
    const value = raw[key];
    if (typeof value !== "string") {
        return fallback;
    }
    return value.trim().toUpperCase();
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

export function hasUiToggleSettings(raw: Record<string, unknown>): boolean {
    return [
        "riskSettingsToggle",
        "tradeFilterSettingsToggle",
        "entrySettingsToggle",
        "riskWinStreakStopLossToggle",
        "invertSignalsToggle",
    ].some((key) => key in raw);
}

export function resolveBacktestSettingsFromRaw(
    settings?: BacktestSettings,
    options?: {
        coerceWithoutUiToggles?: boolean;
    }
): BacktestSettings {
    if (!settings) return {};

    const raw = settings as Record<string, unknown>;
    if (options?.coerceWithoutUiToggles !== false && !hasUiToggleSettings(raw)) {
        const coerced = coerceDeepValue(settings) as BacktestSettings & {
            warmUpEntryEnabled?: unknown;
            warmUpEntryToggle?: unknown;
        };
        delete coerced.warmUpEntryEnabled;
        delete coerced.warmUpEntryToggle;
        if (typeof coerced.polymarketOutcomeSymbol === "string") {
            coerced.polymarketOutcomeSymbol = coerced.polymarketOutcomeSymbol.trim().toUpperCase();
        }
        return coerced;
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
    const guards: ResolverGuardState = {
        useAtrRisk,
        usePercentRisk,
        useAdvancedRisk,
        useRiskMaxHold,
        tradeFilterEnabled,
    };
    const numericSettings = resolveNumericSettingRules(raw, guards);
    const booleanSettings = resolveBooleanSettingRules(raw, guards);

    const resolved: BacktestSettings = {
        ...numericSettings,
        riskMode,
        takeProfitMode: usePercentRisk
            ? resolveTakeProfitMode(raw["takeProfitMode"])
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMode,
        ...booleanSettings,
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
        tradeDirection,
        executionModel,
        polymarketAnnotationEnabled: readBoolean(raw, "polymarketAnnotationEnabled", EFFECTIVE_BACKTEST_DEFAULTS.polymarketAnnotationEnabled),
        polymarketOutcomeSymbol: readString(raw, "polymarketOutcomeSymbol", EFFECTIVE_BACKTEST_DEFAULTS.polymarketOutcomeSymbol),
        polymarketEntryOffset: readNumber(raw, "polymarketEntryOffset", EFFECTIVE_BACKTEST_DEFAULTS.polymarketEntryOffset),
        polymarketExitMode: typeof raw["polymarketExitMode"] === "string"
            && raw["polymarketExitMode"].trim().toLowerCase() === "signal_exit_same_event"
            ? "signal_exit_same_event"
            : EFFECTIVE_BACKTEST_DEFAULTS.polymarketExitMode,
        crossSymbolSecondary: readString(raw, "crossSymbolSecondary", EFFECTIVE_BACKTEST_DEFAULTS.crossSymbolSecondary),
    };

    return resolved;
}
