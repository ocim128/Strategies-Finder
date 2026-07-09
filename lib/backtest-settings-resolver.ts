import type {
    BacktestSettings,
    ConfirmationMode,
    ExecutionModel,
    MarketMode,
    StrategyParams,
    TradeDirection,
    PathExitMode,
} from "./types/strategies";
import {
    readBoolean as readBooleanValue,
    readNumber as readNumberValue,
    toBooleanLike,
    toFiniteNumber,
} from "./settings-parse-utils";
import { resolvePolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import { DEFAULT_POLYMARKET_ENTRY_CUTOFF_SECONDS, clampPolymarketEntryCutoffSeconds } from "./polymarket-entry-cutoff";
import {
    DEFAULT_POLYMARKET_BACKTEST_SLIPPAGE_CENTS,
    clampPolymarketBacktestSlippageCents,
} from "./polymarket-backtest-slippage";
import {
    DEFAULT_POLYMARKET_ENTRY_DELAY_BARS,
    clampPolymarketEntryDelayBars,
} from "./polymarket-entry-delay";
import { clampPolymarketEntryPriceFilterCents } from "./polymarket-entry-price-filter";
import { resolvePolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import { resolvePolymarketExitMode } from "./polymarket-exit-mode";
import {
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_ENABLED,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_MODE,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_PRICE_CENTS,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_OFFSET_CENTS,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_ENABLED,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_MODE,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_PRICE_CENTS,
    DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_OFFSET_CENTS,
    resolvePolymarketPostSignalLimitSettingFields,
} from "./polymarket-post-signal-limit-entry";
import {
    DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS,
    DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_ENABLED,
    DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS,
    DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_ENABLED,
    clampPolymarketProtectionCents,
    resolvePolymarketProtectionSettingFields,
} from "./polymarket-protection-settings";
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
    riskWinStreakStopLossEnabled: false,
    riskWinStreakStopLossAfterWins: 3,
    riskWinStreakStopLossPercent: 0,
    disableSignalExits: false,
    marketMode: "all" as MarketMode,
    tradeDirection: "short" as TradeDirection,
    invertSignals: false,
    flipAfterConsecutiveLosses: 2,
    flipCooldownTrades: 0,
    minTradesBeforeFirstFlip: 0,
    confirmationMode: "agree" as ConfirmationMode,
    confirmationWindowBars: 0,
    executionModel: "next_open" as ExecutionModel,
    allowSameBarExit: false,
    slippageBps: 5,
    maxOpenTrades: 1,
    strategyTimeframeEnabled: false,
    strategyTimeframeMinutes: 120,
    polymarketAnnotationEnabled: false,
    polymarketOutcomeSymbol: "",
    polymarketOutcomeInterval: "5m" as const,
    polymarketEntrySelectionMode: "fixed_offset" as const,
    polymarketEntryOffset: 0,
    polymarketEntryDelayBars: DEFAULT_POLYMARKET_ENTRY_DELAY_BARS,
    polymarketEntryPriceFilterCents: 0,
    polymarketBacktestSlippageCents: DEFAULT_POLYMARKET_BACKTEST_SLIPPAGE_CENTS,
    polymarketEntryCutoffEnabled: false,
    polymarketEntryCutoffSeconds: DEFAULT_POLYMARKET_ENTRY_CUTOFF_SECONDS,
    polymarketExitMode: "resolve_hold" as const,
    polymarketSignalExitAllowMultipleTradesPerEvent: false,
    polymarketPostSignalLimitEntryEnabled: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_ENABLED,
    polymarketPostSignalLimitEntryMode: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_MODE,
    polymarketPostSignalLimitEntryPriceCents: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_PRICE_CENTS,
    polymarketPostSignalLimitEntryOffsetCents: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_ENTRY_OFFSET_CENTS,
    polymarketPostSignalLimitExitEnabled: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_ENABLED,
    polymarketPostSignalLimitExitMode: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_MODE,
    polymarketPostSignalLimitExitPriceCents: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_PRICE_CENTS,
    polymarketPostSignalLimitExitOffsetCents: DEFAULT_POLYMARKET_POST_SIGNAL_LIMIT_EXIT_OFFSET_CENTS,
    polymarketProtectionTakeProfitEnabled: DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_ENABLED,
    polymarketProtectionTakeProfitCents: DEFAULT_POLYMARKET_PROTECTION_TAKE_PROFIT_CENTS,
    polymarketProtectionStopLossEnabled: DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_ENABLED,
    polymarketProtectionStopLossCents: DEFAULT_POLYMARKET_PROTECTION_STOP_LOSS_CENTS,
    pathExitEnabled: false,
    pathExitMode: "off" as PathExitMode,
    pathExitMinBars: 10,
    pathExitMinMfePercent: 2.0,
    pathExitGivebackPercent: 25,
    pathExitLookbackBars: 20,
    pathExitThreshold: 0,
    pathExitMinSamples: 30,
    pathExitHorizonBars: 50,
    crossSymbolSecondary: "",
});

type ResolverGuardName =
    | "useAtrRisk"
    | "usePercentRisk"
    | "useAdvancedRisk"
    | "useRiskManagement"
    | "useRiskMinHold"
    | "useRiskMaxHold";

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
    | "riskMinHoldBars"
    | "riskMaxHoldBars"
    | "riskWinStreakStopLossAfterWins"
    | "riskWinStreakStopLossPercent"
    | "flipAfterConsecutiveLosses"
    | "flipCooldownTrades"
    | "minTradesBeforeFirstFlip"
    | "confirmationWindowBars"
    | "slippageBps"
    | "maxOpenTrades"
    | "strategyTimeframeMinutes"
    | "polymarketEntryDelayBars"
    | "polymarketBacktestSlippageCents"
    | "polymarketEntryCutoffSeconds"
    | "polymarketProtectionTakeProfitCents"
    | "polymarketProtectionStopLossCents"
    | "pathExitMinBars"
    | "pathExitMinMfePercent"
    | "pathExitGivebackPercent"
    | "pathExitLookbackBars"
    | "pathExitThreshold"
    | "pathExitMinSamples"
    | "pathExitHorizonBars";

type BooleanResolverKey =
    | "stopLossEnabled"
    | "takeProfitEnabled"
    | "riskMinHoldEnabled"
    | "riskMaxHoldEnabled"
    | "riskWinStreakStopLossEnabled"
    | "invertSignals"
    | "allowSameBarExit"
    | "strategyTimeframeEnabled"
    | "polymarketEntryCutoffEnabled"
    | "disableSignalExits"
    | "polymarketProtectionTakeProfitEnabled"
    | "polymarketProtectionStopLossEnabled"
    | "pathExitEnabled";

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
    { key: "breakEvenPercent", guard: "useAdvancedRisk", disabledValue: 0 },
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
    {
        key: "riskMinHoldBars",
        guard: "useRiskMinHold",
        disabledValue: 0,
        resolve: (raw) => Math.max(1, Math.round(readDefaultedNumber(raw, "riskMinHoldBars"))),
    },
    { key: "riskMaxHoldBars", guard: "useRiskMaxHold", disabledValue: 0 },
    {
        key: "riskWinStreakStopLossAfterWins",
        guard: "useAdvancedRisk",
        disabledValue: EFFECTIVE_BACKTEST_DEFAULTS.riskWinStreakStopLossAfterWins,
        resolve: (raw) => Math.max(1, Math.round(readDefaultedNumber(raw, "riskWinStreakStopLossAfterWins"))),
    },
    {
        key: "riskWinStreakStopLossPercent",
        guard: "useAdvancedRisk",
        disabledValue: 0,
        resolve: (raw) => Math.max(0, readDefaultedNumber(raw, "riskWinStreakStopLossPercent")),
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
    {
        key: "polymarketEntryDelayBars",
        resolve: (raw) => clampPolymarketEntryDelayBars(raw["polymarketEntryDelayBars"]),
    },
    {
        key: "polymarketBacktestSlippageCents",
        resolve: (raw) => clampPolymarketBacktestSlippageCents(raw["polymarketBacktestSlippageCents"]),
    },
    {
        key: "polymarketEntryCutoffSeconds",
        resolve: (raw) => clampPolymarketEntryCutoffSeconds(raw["polymarketEntryCutoffSeconds"]),
    },
    {
        key: "polymarketProtectionTakeProfitCents",
        resolve: (raw) => clampPolymarketProtectionCents(
            raw["polymarketProtectionTakeProfitCents"],
            EFFECTIVE_BACKTEST_DEFAULTS.polymarketProtectionTakeProfitCents
        ),
    },
    {
        key: "polymarketProtectionStopLossCents",
        resolve: (raw) => clampPolymarketProtectionCents(
            raw["polymarketProtectionStopLossCents"],
            EFFECTIVE_BACKTEST_DEFAULTS.polymarketProtectionStopLossCents
        ),
    },
    { key: "pathExitMinBars", guard: "useRiskManagement", disabledValue: 10 },
    { key: "pathExitMinMfePercent", guard: "useRiskManagement", disabledValue: 2.0 },
    { key: "pathExitGivebackPercent", guard: "useRiskManagement", disabledValue: 25 },
    { key: "pathExitLookbackBars", guard: "useRiskManagement", disabledValue: 20 },
    { key: "pathExitThreshold", guard: "useRiskManagement", disabledValue: 0 },
    { key: "pathExitMinSamples", guard: "useRiskManagement", disabledValue: 30 },
    { key: "pathExitHorizonBars", guard: "useRiskManagement", disabledValue: 50 },
] as const;

const BOOLEAN_RESOLVER_RULES: readonly BooleanResolverRule[] = [
    { key: "stopLossEnabled", keys: ["stopLossEnabled", "stopLossToggle"], guard: "usePercentRisk", disabledValue: false },
    { key: "takeProfitEnabled", keys: ["takeProfitEnabled", "takeProfitToggle"], guard: "usePercentRisk", disabledValue: false },
    { key: "riskMinHoldEnabled", keys: ["riskMinHoldEnabled", "riskMinHoldToggle"], guard: "useRiskMinHold", disabledValue: false },
    { key: "riskMaxHoldEnabled", keys: ["riskMaxHoldEnabled", "riskMaxHoldToggle"], guard: "useRiskMaxHold", disabledValue: false },
    {
        key: "riskWinStreakStopLossEnabled",
        keys: ["riskWinStreakStopLossEnabled", "riskWinStreakStopLossToggle"],
        guard: "useAdvancedRisk",
        disabledValue: false,
    },
    { key: "invertSignals", keys: ["invertSignals", "invertSignalsToggle"] },
    { key: "allowSameBarExit", keys: ["allowSameBarExit", "allowSameBarExitToggle"] },
    { key: "strategyTimeframeEnabled", keys: ["strategyTimeframeEnabled", "strategyTimeframeToggle"] },
    { key: "polymarketEntryCutoffEnabled", keys: ["polymarketEntryCutoffEnabled", "polymarketEntryCutoffToggle"] },
    { key: "disableSignalExits", keys: ["disableSignalExits"] },
    { key: "polymarketProtectionTakeProfitEnabled", keys: ["polymarketProtectionTakeProfitEnabled"] },
    { key: "polymarketProtectionStopLossEnabled", keys: ["polymarketProtectionStopLossEnabled"] },
    { key: "pathExitEnabled", keys: ["pathExitEnabled", "pathExitToggle"], guard: "useRiskManagement", disabledValue: false },
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

    "riskMode",
    "atrPeriod",
    "stopLossAtr",
    "takeProfitAtr",
    "trailingAtr",
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
    "riskMinHoldBars",
    "riskMinHoldToggle",
    "riskMaxHoldBars",
    "riskMaxHoldToggle",
    "disableSignalExits",
    "exitStrategyOverrideEnabled",
    "exitStrategyKey",
    "exitStrategyParams",
    "pathExitEnabled",
    "pathExitMode",
    "pathExitMinBars",
    "pathExitMinMfePercent",
    "pathExitGivebackPercent",
    "pathExitLookbackBars",
    "pathExitThreshold",
    "pathExitMinSamples",
    "pathExitHorizonBars",
    "tradeDirection",
    "invertSignalsToggle",
    "flipAfterConsecutiveLosses",
    "flipCooldownTrades",
    "minTradesBeforeFirstFlip",
    "confirmationStrategiesToggle",
    "confirmationStrategies",
    "confirmationMode",
    "confirmationWindowBars",
    "confirmationStrategyParams",
    "executionModel",
    "slippageBps",
    "maxOpenTrades",
    "strategyTimeframeToggle",
    "strategyTimeframeMinutes",
    "polymarketAnnotationEnabled",
    "polymarketOutcomeSymbol",
    "polymarketOutcomeInterval",
    "polymarketEntrySelectionMode",
    "polymarketEntryOffset",
    "polymarketEntryDelayBars",
    "polymarketEntryPriceFilterCents",
    "polymarketBacktestSlippageCents",
    "polymarketEntryCutoffToggle",
    "polymarketEntryCutoffSeconds",
    "polymarketExitMode",
    "polymarketSignalExitAllowMultipleTradesPerEvent",
    "polymarketPostSignalLimitEntryEnabled",
    "polymarketPostSignalLimitEntryMode",
    "polymarketPostSignalLimitEntryPriceCents",
    "polymarketPostSignalLimitEntryOffsetCents",
    "polymarketPostSignalLimitExitEnabled",
    "polymarketPostSignalLimitExitMode",
    "polymarketPostSignalLimitExitPriceCents",
    "polymarketPostSignalLimitExitOffsetCents",
    "polymarketProtectionTakeProfitEnabled",
    "polymarketProtectionTakeProfitCents",
    "polymarketProtectionStopLossEnabled",
    "polymarketProtectionStopLossCents",
    "crossSymbolSecondary",
    "batchExecutionMode",
    "finderUniverseExecutionMode",
]);

const VALID_TRADE_DIRECTIONS = new Set<TradeDirection>(["long", "short", "both", "both_flip_loss_2", "combined"]);
const VALID_CONFIRMATION_MODES = new Set<ConfirmationMode>([
    "agree",
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

function resolvePathExitMode(rawValue: unknown): PathExitMode {
    if (typeof rawValue === "string") {
        const mode = rawValue.trim().toLowerCase() as PathExitMode;
        if (
            mode === "off" ||
            mode === "mfe_giveback" ||
            mode === "momentum_deceleration" ||
            mode === "capitulation_exhaustion" ||
            mode === "squeeze_pressure" ||
            mode === "conditional_hazard" ||
            mode === "triple_barrier_meta" ||
            mode === "structure_reclaim" ||
            mode === "profit_compression"
        ) {
            return mode;
        }
    }
    return "off";
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

function readTradeDirection(rawValue: unknown, fallback: TradeDirection): TradeDirection {
    if (typeof rawValue === "string") {
        const direction = rawValue.trim().toLowerCase() as TradeDirection;
        if (VALID_TRADE_DIRECTIONS.has(direction)) return direction;
    }
    return fallback;
}

function readStringArray(rawValue: unknown): string[] {
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

function readConfirmationMode(rawValue: unknown, fallback: ConfirmationMode): ConfirmationMode {
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

function hasActivePathExit(settings: Record<string, unknown>): boolean {
    return settings.pathExitEnabled === true && resolvePathExitMode(settings.pathExitMode) !== "off";
}

function applyDerivedBacktestSettingGuards(settings: Record<string, unknown>): Record<string, unknown> {
    // Keep disableSignalExits only when another chart-managed exit can close the trade.
    if (
        settings.disableSignalExits === true
        && !hasActiveChartTakeProfitOrStopLoss(settings)
        && !hasActivePathExit(settings)
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
        if (typeof coerced.polymarketOutcomeSymbol === "string") {
            coerced.polymarketOutcomeSymbol = coerced.polymarketOutcomeSymbol.trim().toUpperCase();
        }
        coerced.polymarketOutcomeInterval = resolvePolymarketOutcomeInterval(coerced.polymarketOutcomeInterval);
        coerced.polymarketEntryDelayBars = clampPolymarketEntryDelayBars(coerced.polymarketEntryDelayBars);
        coerced.polymarketEntryPriceFilterCents = clampPolymarketEntryPriceFilterCents(coerced.polymarketEntryPriceFilterCents);
        coerced.polymarketBacktestSlippageCents = clampPolymarketBacktestSlippageCents(coerced.polymarketBacktestSlippageCents);
        coerced.polymarketEntryCutoffEnabled = readBooleanAny(raw, ["polymarketEntryCutoffEnabled", "polymarketEntryCutoffToggle"], EFFECTIVE_BACKTEST_DEFAULTS.polymarketEntryCutoffEnabled);
        coerced.polymarketEntryCutoffSeconds = clampPolymarketEntryCutoffSeconds(raw["polymarketEntryCutoffSeconds"]);
        coerced.disableSignalExits = readBoolean(raw, "disableSignalExits", EFFECTIVE_BACKTEST_DEFAULTS.disableSignalExits);
        coerced.exitStrategyOverrideEnabled = readBoolean(raw, "exitStrategyOverrideEnabled", false);
        coerced.exitStrategyKey = typeof raw["exitStrategyKey"] === "string" ? raw["exitStrategyKey"].trim() : "";
        coerced.exitStrategyParams = readStrategyParams(raw["exitStrategyParams"]);
        coerced.pathExitEnabled = readBoolean(raw, "pathExitEnabled", EFFECTIVE_BACKTEST_DEFAULTS.pathExitEnabled);
        coerced.pathExitMode = resolvePathExitMode(raw["pathExitMode"]);
        Object.assign(coerced, resolvePolymarketPostSignalLimitSettingFields(
            raw,
            (key, fallback) => readBoolean(raw, key, fallback)
        ));
        Object.assign(coerced, resolvePolymarketProtectionSettingFields(
            raw,
            (key, fallback) => readBoolean(raw, key, fallback)
        ));
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
    const useAdvancedRisk = false;
    const useRiskMinHold = riskEnabled;
    const useRiskMaxHold = riskEnabled;

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

    const marketMode: MarketMode = EFFECTIVE_BACKTEST_DEFAULTS.marketMode;
    const guards: ResolverGuardState = {
        useAtrRisk,
        usePercentRisk,
        useAdvancedRisk,
        useRiskManagement: riskEnabled,
        useRiskMinHold,
        useRiskMaxHold,
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
        confirmationStrategies,
        confirmationMode,
        confirmationWindowBars,
        confirmationStrategyParams,
        tradeDirection,
        executionModel,
        exitStrategyOverrideEnabled: readBoolean(raw, "exitStrategyOverrideEnabled", false),
        exitStrategyKey: typeof raw["exitStrategyKey"] === "string" ? raw["exitStrategyKey"].trim() : "",
        exitStrategyParams: readStrategyParams(raw["exitStrategyParams"]),
        pathExitMode: riskEnabled
            ? resolvePathExitMode(raw["pathExitMode"])
            : "off",
        polymarketAnnotationEnabled: readBoolean(raw, "polymarketAnnotationEnabled", EFFECTIVE_BACKTEST_DEFAULTS.polymarketAnnotationEnabled),
        polymarketOutcomeSymbol: readString(raw, "polymarketOutcomeSymbol", EFFECTIVE_BACKTEST_DEFAULTS.polymarketOutcomeSymbol),
        polymarketOutcomeInterval: resolvePolymarketOutcomeInterval(raw["polymarketOutcomeInterval"]),
        polymarketEntrySelectionMode: resolvePolymarketEntrySelectionMode(raw["polymarketEntrySelectionMode"]),
        polymarketEntryOffset: readNumber(raw, "polymarketEntryOffset", EFFECTIVE_BACKTEST_DEFAULTS.polymarketEntryOffset),
        polymarketEntryDelayBars: numericSettings.polymarketEntryDelayBars,
        polymarketEntryPriceFilterCents: clampPolymarketEntryPriceFilterCents(raw["polymarketEntryPriceFilterCents"]),
        polymarketBacktestSlippageCents: numericSettings.polymarketBacktestSlippageCents,
        polymarketEntryCutoffEnabled: booleanSettings.polymarketEntryCutoffEnabled,
        polymarketEntryCutoffSeconds: numericSettings.polymarketEntryCutoffSeconds,
        polymarketExitMode: resolvePolymarketExitMode(
            raw["polymarketExitMode"],
            EFFECTIVE_BACKTEST_DEFAULTS.polymarketExitMode
        ),
        polymarketSignalExitAllowMultipleTradesPerEvent: readBoolean(
            raw,
            "polymarketSignalExitAllowMultipleTradesPerEvent",
            EFFECTIVE_BACKTEST_DEFAULTS.polymarketSignalExitAllowMultipleTradesPerEvent
        ),
        ...resolvePolymarketPostSignalLimitSettingFields(
            raw,
            (key, fallback) => readBoolean(raw, key, fallback)
        ),
        ...resolvePolymarketProtectionSettingFields(
            raw,
            (key, fallback) => readBoolean(raw, key, fallback)
        ),
        crossSymbolSecondary: readString(raw, "crossSymbolSecondary", EFFECTIVE_BACKTEST_DEFAULTS.crossSymbolSecondary),
    };

    return applyDerivedBacktestSettingGuards(
        applyRemovedBacktestSettingDefaults(resolved as Record<string, unknown>)
    ) as BacktestSettings;
}
