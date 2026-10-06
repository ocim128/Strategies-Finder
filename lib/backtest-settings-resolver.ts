import type {
    BacktestSettings,
    ConfirmationMode,
    ExecutionModel,
    MarketMode,
    StrategyParams,
    TradeDirection,
    EntryConfirmationMove,
} from "./types/strategies";
import { MAX_OPEN_TRADES_UNLIMITED } from "./types/backtest";
import {
    readBoolean as readBooleanValue,
    readNumber as readNumberValue,
    toBooleanLike,
    toFiniteNumber,
} from "./settings-parse-utils";
import { ADAPTIVE_TAKE_PROFIT_DEFAULTS, resolveTakeProfitMode } from "./take-profit-settings";
import { DEFAULT_ENTRY_TIME_FILTER, resolveEntryTimeFilter } from "./entry-time-filter";

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
    partialTakeProfitAtR: 0,
    partialTakeProfitPercent: 0,
    breakEvenAtR: 0,
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
    riskMinHoldBars: 10,
    riskMinHoldEnabled: false,
    riskMaxHoldBars: 10,
    riskMaxHoldEnabled: false,
    riskCooldownEnabled: true,
    riskCooldownBars: 1,
    riskEntryConfirmationEnabled: false,
    riskEntryConfirmationPercent: 1,
    riskEntryConfirmationBars: 3,
    riskEntryConfirmationMove: "both" as EntryConfirmationMove,
    entryTimeFilterEnabled: false,
    entryTimeFilter: DEFAULT_ENTRY_TIME_FILTER,
    riskWinStreakStopLossEnabled: false,
    riskWinStreakStopLossAfterWins: 3,
    riskWinStreakStopLossPercent: 0,
    disableSignalExits: false,
    marketMode: "all" as MarketMode,
    tradeDirection: "short" as TradeDirection,
    invertSignals: false,
    confirmationMode: "agree" as ConfirmationMode,
    confirmationSignalExitsEnabled: true,
    confirmationWindowBars: 0,
    executionModel: "next_open" as ExecutionModel,
    allowSameBarExit: false,
    slippageBps: 5,
    maxOpenTrades: 1,
    strategyTimeframeEnabled: false,
    strategyTimeframeMinutes: 120,
});

const VALID_TRADE_DIRECTIONS = new Set<TradeDirection>(["long", "short", "both", "both_no_flip", "combined"]);
const VALID_CONFIRMATION_MODES = new Set<ConfirmationMode>([
    "agree",
    "disagree",
    "veto_opposite",
    "confirm_within_window",
    "veto_within_window",
]);
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

/**
 * Shared pure parser for the entry-confirmation move direction (trim +
 * lowercase). `fallback` lets DOM callers supply their own default while the
 * raw resolver keeps the effective default.
 */
export function resolveEntryConfirmationMove(
    rawValue: unknown,
    fallback: EntryConfirmationMove = EFFECTIVE_BACKTEST_DEFAULTS.riskEntryConfirmationMove,
): EntryConfirmationMove {
    if (typeof rawValue === "string") {
        const move = rawValue.trim().toLowerCase() as EntryConfirmationMove;
        if (move === "down" || move === "up" || move === "both") return move;
    }
    return fallback;
}

function readNumber(raw: Record<string, unknown>, key: string, fallback: number): number {
    return readNumberValue(raw[key], fallback);
}

function readBoolean(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
    return readBooleanValue(raw[key], fallback);
}

function readBooleanAny(raw: Record<string, unknown>, keys: string[], fallback: boolean): boolean {
    for (const key of keys) {
        if (!(key in raw)) continue;
        const parsed = toBooleanLike(raw[key]);
        if (parsed !== null) return parsed;
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

/** Shared pure parser for strategy-name lists: strings split on commas; items
 * are trimmed, and empty items plus duplicates are dropped (case-sensitive). */
export function readStringArray(rawValue: unknown): string[] {
    const source = Array.isArray(rawValue)
        ? rawValue
        : typeof rawValue === "string"
            ? rawValue.split(",")
            : [];
    const seen = new Set<string>();
    const items: string[] = [];
    for (const item of source) {
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
    let rawSource = rawValue;
    if (typeof rawValue === "string") {
        try {
            rawSource = JSON.parse(rawValue || "{}");
        } catch {
            return {};
        }
    }
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) return {};

    const source = coerceDeepValue(rawSource);
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};

    const result: Record<string, StrategyParams> = {};
    for (const [strategyKey, strategyParamsRaw] of Object.entries(source as Record<string, unknown>)) {
        if (allowedStrategies && !allowedStrategies.has(strategyKey)) {
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

function readStrategyParams(rawValue: unknown): StrategyParams {
    let rawSource = rawValue;
    if (typeof rawValue === "string") {
        try {
            rawSource = JSON.parse(rawValue || "{}");
        } catch {
            return {};
        }
    }
    if (!rawSource || typeof rawSource !== "object" || Array.isArray(rawSource)) return {};

    const source = coerceDeepValue(rawSource);
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};

    const result: StrategyParams = {};
    for (const [paramKey, paramValue] of Object.entries(source as Record<string, unknown>)) {
        const parsed = toFiniteNumber(paramValue);
        if (parsed !== null) {
            result[paramKey] = parsed;
        }
    }
    return result;
}

/** Shared pure parser for confirmation mode values (trim + lowercase, caller
 * supplies the fallback). */
export function readConfirmationMode(rawValue: unknown, fallback: ConfirmationMode): ConfirmationMode {
    if (typeof rawValue === "string") {
        const mode = rawValue.trim().toLowerCase() as ConfirmationMode;
        if (VALID_CONFIRMATION_MODES.has(mode)) return mode;
    }
    return fallback;
}

function clampConfirmationWindowBars(rawValue: unknown): number {
    const parsed = toFiniteNumber(rawValue);
    if (parsed === null) return EFFECTIVE_BACKTEST_DEFAULTS.confirmationWindowBars;
    return Math.max(0, Math.round(parsed));
}

function hasActiveChartTakeProfitOrStopLoss(settings: Record<string, unknown>): boolean {
    const riskMode = settings.riskMode === "percentage" ? "percentage" : "simple";
    if (riskMode === "percentage") {
        const stopLossPercent = toFiniteNumber(settings.stopLossPercent) ?? 0;
        const takeProfitPercent = toFiniteNumber(settings.takeProfitPercent) ?? 0;
        return (settings.stopLossEnabled === true && stopLossPercent > 0)
            || (settings.takeProfitEnabled === true && takeProfitPercent > 0);
    }
    return (toFiniteNumber(settings.stopLossAtr) ?? 0) > 0
        || (toFiniteNumber(settings.takeProfitAtr) ?? 0) > 0;
}

function applyDerivedBacktestSettingGuards(settings: Record<string, unknown>): Record<string, unknown> {
    // Keep disableSignalExits only when another chart-managed exit can close the trade.
    if (
        settings.disableSignalExits === true
        && !hasActiveChartTakeProfitOrStopLoss(settings)
        && !settings.exitStrategyOverrideEnabled
    ) {
        settings.disableSignalExits = false;
    }
    return settings;
}

export function hasUiToggleSettings(raw: Record<string, unknown>): boolean {
    return [
        "riskSettingsToggle",
        "invertSignalsToggle",
        "confirmationSignalExitsToggle",
    ].some((key) => key in raw);
}

function applyRemovedBacktestSettingDefaults(settings: Record<string, unknown>): Record<string, unknown> {
    settings.riskMode = settings.riskMode === "percentage" ? "percentage" : EFFECTIVE_BACKTEST_DEFAULTS.riskMode;
    settings.partialTakeProfitAtR = 0;
    settings.partialTakeProfitPercent = 0;
    settings.breakEvenAtR = 0;
    settings.breakEvenPercent = 0;
    settings.timeStopBars = 0;
    settings.riskWinStreakStopLossEnabled = false;
    settings.riskWinStreakStopLossAfterWins = EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossAfterWins;
    settings.riskWinStreakStopLossPercent = 0;
    settings.marketMode = EFFECTIVE_BACKTEST_DEFAULTS.marketMode;
    settings.allowSameBarExit = EFFECTIVE_BACKTEST_DEFAULTS.allowSameBarExit;
    delete settings.tradeFilterMode;
    delete settings.crossSymbolSecondary;
    delete settings.tradeFilterSettingsToggle;
    delete settings.entrySettingsToggle;
    delete settings.entryConfirmation;
    delete settings.htfBiasEmaPeriod;
    delete settings.executionTrendEmaPeriod;
    delete settings.confirmLookback;
    delete settings.volumeSmaPeriod;
    delete settings.volumeMultiplier;
    delete settings.confirmRsiPeriod;
    delete settings.confirmRsiBullish;
    delete settings.confirmRsiBearish;
    delete settings.rsiPeriod;
    delete settings.rsiBullish;
    delete settings.rsiBearish;
    delete settings.historicalLevelTakeProfitEnabled;
    delete settings.historicalLevelStopLossEnabled;
    delete settings.historicalLevelLookbackBars;
    delete settings.pathExitToggle;
    delete settings.pathExitEnabled;
    delete settings.pathExitMode;
    delete settings.pathExitMinBars;
    delete settings.pathExitMinMfePercent;
    delete settings.pathExitGivebackPercent;
    delete settings.pathExitLookbackBars;
    delete settings.pathExitThreshold;
    delete settings.pathExitMinSamples;
    delete settings.pathExitHorizonBars;
    return settings;
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
        coerced.disableSignalExits = readBoolean(raw, "disableSignalExits", EFFECTIVE_BACKTEST_DEFAULTS.disableSignalExits);
        coerced.confirmationSignalExitsEnabled = readBooleanAny(
            raw,
            ["confirmationSignalExitsEnabled", "confirmationSignalExitsToggle"],
            EFFECTIVE_BACKTEST_DEFAULTS.confirmationSignalExitsEnabled
        );
        coerced.riskEntryConfirmationMove = resolveEntryConfirmationMove(coerced.riskEntryConfirmationMove);
        coerced.entryTimeFilterEnabled = readBooleanAny(raw, ["entryTimeFilterEnabled", "riskEntryTimeFilterToggle"], false);
        coerced.entryTimeFilter = resolveEntryTimeFilter(raw["entryTimeFilter"] ?? raw["riskEntryTimeFilter"]);
        coerced.exitStrategyOverrideEnabled = readBoolean(raw, "exitStrategyOverrideEnabled", false);
        coerced.exitStrategyKey = typeof raw["exitStrategyKey"] === "string" ? raw["exitStrategyKey"].trim() : "";
        coerced.exitStrategyParams = readStrategyParams(raw["exitStrategyParams"]);
        if ("confirmationStrategies" in raw || "confirmationStrategiesToggle" in raw) {
            const rawConfirmationStrategies = readStringArray(raw["confirmationStrategies"]);
            const confirmationStrategiesEnabled = readBoolean(
                raw,
                "confirmationStrategiesToggle",
                rawConfirmationStrategies.length > 0
            );
            const confirmationStrategies = confirmationStrategiesEnabled ? rawConfirmationStrategies : [];
            coerced.confirmationStrategies = confirmationStrategies;
            coerced.confirmationMode = readConfirmationMode(
                raw["confirmationMode"],
                EFFECTIVE_BACKTEST_DEFAULTS.confirmationMode
            );
            coerced.confirmationWindowBars = clampConfirmationWindowBars(raw["confirmationWindowBars"]);
            coerced.confirmationStrategyParams = confirmationStrategiesEnabled
                ? readConfirmationStrategyParams(raw["confirmationStrategyParams"], new Set(confirmationStrategies))
                : {};
        }
        return applyDerivedBacktestSettingGuards(
            applyRemovedBacktestSettingDefaults(coerced as Record<string, unknown>)
        ) as BacktestSettings;
    }

    const riskEnabled = readBoolean(raw, "riskSettingsToggle", false);
    const riskModeRaw = raw["riskMode"];
    const riskMode: BacktestSettings["riskMode"] =
        riskModeRaw === "percentage"
            ? riskModeRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.riskMode;
    const useAtrRisk = riskEnabled && riskMode === "simple";
    const usePercentRisk = riskEnabled && riskMode === "percentage";

    const rawConfirmationStrategies = readStringArray(raw["confirmationStrategies"]);
    const confirmationStrategiesEnabled = readBoolean(
        raw,
        "confirmationStrategiesToggle",
        rawConfirmationStrategies.length > 0
    );
    const confirmationStrategies = confirmationStrategiesEnabled ? rawConfirmationStrategies : [];
    const allowedConfirmationStrategies = new Set(confirmationStrategies);
    const confirmationMode = readConfirmationMode(
        raw["confirmationMode"],
        EFFECTIVE_BACKTEST_DEFAULTS.confirmationMode
    );
    const confirmationWindowBars = clampConfirmationWindowBars(raw["confirmationWindowBars"]);
    const confirmationStrategyParams = confirmationStrategiesEnabled
        ? readConfirmationStrategyParams(raw["confirmationStrategyParams"], allowedConfirmationStrategies)
        : {};

    const executionModelRaw = raw["executionModel"];
    const executionModel: ExecutionModel =
        executionModelRaw === "signal_close" || executionModelRaw === "next_open" || executionModelRaw === "next_close"
            ? executionModelRaw
            : EFFECTIVE_BACKTEST_DEFAULTS.executionModel;
    const tradeDirection = readTradeDirection(raw["tradeDirection"], EFFECTIVE_BACKTEST_DEFAULTS.tradeDirection);
    const entryTimeFilter = resolveEntryTimeFilter(raw["entryTimeFilter"] ?? raw["riskEntryTimeFilter"]);

    // Explicit resolution: every field's parse, guard, disabled value, and
    // clamp reads together. Guarded fields fall back to their disabled value
    // when the guard fails and to EFFECTIVE_BACKTEST_DEFAULTS when the key is
    // merely absent; toggle aliases resolve first-present-key-wins.
    const maxOpenTradesParsed = Math.round(
        readNumber(raw, "maxOpenTrades", EFFECTIVE_BACKTEST_DEFAULTS.maxOpenTrades),
    );
    const resolved: BacktestSettings = {
        atrPeriod: readNumber(raw, "atrPeriod", EFFECTIVE_BACKTEST_DEFAULTS.atrPeriod),
        stopLossAtr: useAtrRisk
            ? readNumber(raw, "stopLossAtr", EFFECTIVE_BACKTEST_DEFAULTS.stopLossAtr)
            : 0,
        takeProfitAtr: useAtrRisk
            ? readNumber(raw, "takeProfitAtr", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAtr)
            : 0,
        trailingAtr: useAtrRisk
            ? readNumber(raw, "trailingAtr", EFFECTIVE_BACKTEST_DEFAULTS.trailingAtr)
            : 0,
        stopLossPercent: usePercentRisk
            ? readNumber(raw, "stopLossPercent", EFFECTIVE_BACKTEST_DEFAULTS.stopLossPercent)
            : 0,
        takeProfitPercent: usePercentRisk
            ? readNumber(raw, "takeProfitPercent", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitPercent)
            : 0,
        takeProfitMfeBootstrapPercentile: usePercentRisk
            ? Math.max(1, Math.min(99, readNumber(raw, "takeProfitMfeBootstrapPercentile", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeBootstrapPercentile)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMfeBootstrapPercentile,
        takeProfitAdaptiveLookbackTrades: usePercentRisk
            ? Math.max(5, Math.round(readNumber(raw, "takeProfitAdaptiveLookbackTrades", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveLookbackTrades)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveLookbackTrades,
        takeProfitAdaptiveRecentWindow: usePercentRisk
            ? Math.max(3, Math.round(readNumber(raw, "takeProfitAdaptiveRecentWindow", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveRecentWindow)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveRecentWindow,
        takeProfitAdaptiveMinMultiplier: usePercentRisk
            ? Math.max(0.1, readNumber(raw, "takeProfitAdaptiveMinMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveMinMultiplier))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveMinMultiplier,
        takeProfitAdaptiveMaxMultiplier: usePercentRisk
            ? Math.max(0.2, readNumber(raw, "takeProfitAdaptiveMaxMultiplier", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveMaxMultiplier))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveMaxMultiplier,
        takeProfitAdaptiveGridSteps: usePercentRisk
            ? Math.max(3, Math.round(readNumber(raw, "takeProfitAdaptiveGridSteps", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveGridSteps)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveGridSteps,
        takeProfitAdaptiveRegimeBlend: usePercentRisk
            ? Math.max(0, Math.min(1, readNumber(raw, "takeProfitAdaptiveRegimeBlend", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveRegimeBlend)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveRegimeBlend,
        takeProfitAdaptiveIcScale: usePercentRisk
            ? Math.max(0, Math.min(2, readNumber(raw, "takeProfitAdaptiveIcScale", EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveIcScale)))
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitAdaptiveIcScale,
        riskMinHoldBars: riskEnabled
            ? Math.max(1, Math.round(readNumber(raw, "riskMinHoldBars", EFFECTIVE_BACKTEST_DEFAULTS.riskMinHoldBars)))
            : 0,
        // Deliberately unrounded like the guarded path before it: max-hold
        // stays fractional while min-hold rounds to whole bars.
        riskMaxHoldBars: riskEnabled
            ? readNumber(raw, "riskMaxHoldBars", EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldBars)
            : 0,
        riskCooldownBars: riskEnabled
            ? Math.max(0, Math.round(readNumber(raw, "riskCooldownBars", EFFECTIVE_BACKTEST_DEFAULTS.riskCooldownBars)))
            : 0,
        riskEntryConfirmationPercent: riskEnabled
            ? Math.max(0, Math.min(100, readNumber(raw, "riskEntryConfirmationPercent", EFFECTIVE_BACKTEST_DEFAULTS.riskEntryConfirmationPercent)))
            : 0,
        riskEntryConfirmationBars: riskEnabled
            ? Math.max(1, Math.round(readNumber(raw, "riskEntryConfirmationBars", EFFECTIVE_BACKTEST_DEFAULTS.riskEntryConfirmationBars)))
            : 0,
        slippageBps: readNumber(raw, "slippageBps", EFFECTIVE_BACKTEST_DEFAULTS.slippageBps),
        // Only the explicit DOM value 3 selects unlimited overlap; any other
        // out-of-range garbage clamps back to the conservative capped range.
        maxOpenTrades: maxOpenTradesParsed === MAX_OPEN_TRADES_UNLIMITED
            ? maxOpenTradesParsed
            : Math.max(1, Math.min(2, maxOpenTradesParsed)),
        strategyTimeframeMinutes: readNumber(raw, "strategyTimeframeMinutes", EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeMinutes),
        riskMode,
        takeProfitMode: usePercentRisk
            ? resolveTakeProfitMode(raw["takeProfitMode"])
            : EFFECTIVE_BACKTEST_DEFAULTS.takeProfitMode,
        stopLossEnabled: usePercentRisk
            ? readBooleanAny(raw, ["stopLossEnabled", "stopLossToggle"], EFFECTIVE_BACKTEST_DEFAULTS.stopLossEnabled)
            : false,
        takeProfitEnabled: usePercentRisk
            ? readBooleanAny(raw, ["takeProfitEnabled", "takeProfitToggle"], EFFECTIVE_BACKTEST_DEFAULTS.takeProfitEnabled)
            : false,
        riskMinHoldEnabled: riskEnabled
            ? readBooleanAny(raw, ["riskMinHoldEnabled", "riskMinHoldToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskMinHoldEnabled)
            : false,
        riskMaxHoldEnabled: riskEnabled
            ? readBooleanAny(raw, ["riskMaxHoldEnabled", "riskMaxHoldToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskMaxHoldEnabled)
            : false,
        riskCooldownEnabled: riskEnabled
            ? readBooleanAny(raw, ["riskCooldownEnabled", "riskCooldownToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskCooldownEnabled)
            : false,
        riskEntryConfirmationEnabled: riskEnabled
            ? readBooleanAny(raw, ["riskEntryConfirmationEnabled", "riskEntryConfirmationToggle"], EFFECTIVE_BACKTEST_DEFAULTS.riskEntryConfirmationEnabled)
            : false,
        entryTimeFilterEnabled: riskEnabled
            ? readBooleanAny(raw, ["entryTimeFilterEnabled", "riskEntryTimeFilterToggle"], EFFECTIVE_BACKTEST_DEFAULTS.entryTimeFilterEnabled)
            : false,
        invertSignals: readBooleanAny(raw, ["invertSignals", "invertSignalsToggle"], EFFECTIVE_BACKTEST_DEFAULTS.invertSignals),
        strategyTimeframeEnabled: readBooleanAny(raw, ["strategyTimeframeEnabled", "strategyTimeframeToggle"], EFFECTIVE_BACKTEST_DEFAULTS.strategyTimeframeEnabled),
        disableSignalExits: readBoolean(raw, "disableSignalExits", EFFECTIVE_BACKTEST_DEFAULTS.disableSignalExits),
        confirmationSignalExitsEnabled: readBooleanAny(
            raw,
            ["confirmationSignalExitsEnabled", "confirmationSignalExitsToggle"],
            EFFECTIVE_BACKTEST_DEFAULTS.confirmationSignalExitsEnabled,
        ),
        riskEntryConfirmationMove: resolveEntryConfirmationMove(raw["riskEntryConfirmationMove"]),
        entryTimeFilter,
        trendEmaPeriod: 0,
        trendEmaSlopeBars: 0,
        atrPercentMin: 0,
        atrPercentMax: 0,
        adxPeriod: 14,
        adxMin: 0,
        adxMax: 0,
        confirmationStrategies,
        confirmationMode,
        confirmationWindowBars,
        confirmationStrategyParams,
        tradeDirection,
        executionModel,
        exitStrategyOverrideEnabled: readBoolean(raw, "exitStrategyOverrideEnabled", false),
        exitStrategyKey: typeof raw["exitStrategyKey"] === "string" ? raw["exitStrategyKey"].trim() : "",
        exitStrategyParams: readStrategyParams(raw["exitStrategyParams"]),
    };

    return applyDerivedBacktestSettingGuards(
        applyRemovedBacktestSettingDefaults(resolved as Record<string, unknown>)
    ) as BacktestSettings;
}
