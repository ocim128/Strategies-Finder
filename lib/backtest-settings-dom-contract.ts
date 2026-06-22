import { parseInputNumber } from "./dom-input-readers";
import { readBoolean, readNumber } from "./settings-parse-utils";
import {
    resolveKellyFraction,
    resolveMartingaleBaseSize,
    resolveRiskParityMethod,
    resolveSecureFMethod,
    resolveVolScalingMethod,
} from "./advanced-sizing-settings";
import { TAKE_PROFIT_DOM_IDS } from "./take-profit-dom";
import {
    DEFAULT_BACKTEST_SETTINGS,
    resolveExecutionModelValue,
    resolveMarketMode,
    resolveRiskModeValue,
    resolveTakeProfitModeValue,
    resolveTradeDirection,
    resolveTradeSizingModeValue,
    type BacktestSettingsData,
} from "./settings-model";
import { resolvePolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import { clampPolymarketEntryDelayBars } from "./polymarket-entry-delay";
import { clampPolymarketEntryPriceFilterCents } from "./polymarket-entry-price-filter";
import { clampPolymarketBacktestSlippageCents } from "./polymarket-backtest-slippage";
import { resolvePolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import { resolvePolymarketExitMode } from "./polymarket-exit-mode";
import {
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    resolvePolymarketPostSignalLimitEntryMode,
    resolvePolymarketPostSignalLimitExitMode,
} from "./polymarket-post-signal-limit-entry";
import { clampPolymarketProtectionCents } from "./polymarket-protection-settings";
import { RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS } from "./rust-settings-sanitizer";
import { resolveTakeProfitMode } from "./take-profit-settings";
import type { BacktestSettings, StrategyParams } from "./types/strategies";

export type BacktestDomSettingKey = keyof BacktestSettingsData;
export type BacktestDomSettingParser =
    | "number"
    | "boolean"
    | "string"
    | "stringArray"
    | "confirmationMode"
    | "confirmationStrategyParams"
    | "polymarketOutcomeInterval"
    | "polymarketEntrySelectionMode"
    | "polymarketEntryDelayBars"
    | "polymarketEntryPriceFilterCents"
    | "polymarketBacktestSlippageCents"
    | "polymarketExitMode"
    | "polymarketLimitEntryPriceCents"
    | "polymarketLimitExitPriceCents"
    | "polymarketLimitOffsetCents"
    | "polymarketLimitEntryMode"
    | "polymarketLimitExitMode"
    | "polymarketProtectionCents"
    | "riskMode"
    | "takeProfitMode"
    | "tradeDirection"
    | "marketMode"
    | "executionModel"
    | "tradeSizingMode"
    | "kellyFraction"
    | "volScalingMethod"
    | "riskParityMethod"
    | "martingaleBaseSize"
    | "secureFMethod"
    | "strategyKey"
    | "strategyParams";

export type SettingSupportLevel = "supported" | "unsupported" | "conditional" | "ui_only";

export interface BacktestDomSettingContract {
    domId: string;
    settingKey: BacktestDomSettingKey;
    parser: BacktestDomSettingParser;
    legacyAliases: readonly string[];
    rustSupport: SettingSupportLevel;
    workerSupport: SettingSupportLevel;
    fallbackValue?: unknown;
    readFromSettings?: (settings: BacktestSettingsData) => unknown;
}

type BacktestDomSettingOptions = Partial<Omit<BacktestDomSettingContract, "domId">>;

function createField(domId: string, options: BacktestDomSettingOptions = {}): BacktestDomSettingContract {
    const settingKey = options.settingKey ?? (domId as BacktestDomSettingKey);
    return {
        domId,
        settingKey,
        parser: options.parser ?? inferParser(settingKey),
        legacyAliases: options.legacyAliases ?? [],
        rustSupport: options.rustSupport ?? inferRustSupport(settingKey),
        workerSupport: options.workerSupport ?? "supported",
        fallbackValue: options.fallbackValue,
        readFromSettings: options.readFromSettings,
    };
}

function inferParser(settingKey: BacktestDomSettingKey): BacktestDomSettingParser {
    switch (settingKey) {
        case "riskMode":
            return "riskMode";
        case "takeProfitMode":
            return "takeProfitMode";
        case "tradeDirection":
            return "tradeDirection";
        case "marketMode":
            return "marketMode";
        case "executionModel":
            return "executionModel";
        case "sizingMode":
            return "tradeSizingMode";
        case "confirmationStrategies":
            return "stringArray";
        case "confirmationMode":
            return "confirmationMode";
        case "confirmationStrategyParams":
            return "confirmationStrategyParams";
        case "exitStrategyKey":
            return "strategyKey";
        case "exitStrategyParams":
            return "strategyParams";
        case "kellyFraction":
            return "kellyFraction";
        case "volScalingMethod":
            return "volScalingMethod";
        case "riskParityMethod":
            return "riskParityMethod";
        case "martingaleBaseSize":
            return "martingaleBaseSize";
        case "secureFMethod":
            return "secureFMethod";
        default: {
            const fallback = (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[settingKey];
            if (typeof fallback === "number") {
                return "number";
            }
            if (typeof fallback === "string") {
                return "string";
            }
            return "boolean";
        }
    }
}

const RUST_UNSUPPORTED_KEY_SET = new Set<string>(RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS as readonly string[]);

function inferRustSupport(settingKey: BacktestDomSettingKey): SettingSupportLevel {
    if (settingKey === "useRustEngine") {
        return "ui_only";
    }
    if (settingKey === "tradeDirection" || settingKey === "marketMode" || settingKey === "takeProfitMode") {
        return "conditional";
    }
    return RUST_UNSUPPORTED_KEY_SET.has(settingKey as keyof BacktestSettings as string)
        ? "unsupported"
        : "supported";
}

const BASE_BACKTEST_DOM_CONTRACTS = [
    createField("initialCapital"),
    createField("positionSize"),
    createField("commission"),
    createField("fixedTradeToggle"),
    createField("tradeSizingMode", {
        settingKey: "sizingMode",
        parser: "tradeSizingMode",
        legacyAliases: ["sizingMode"],
        readFromSettings: (settings) => resolveTradeSizingModeValue(settings.sizingMode, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("fixedTradeAmount"),
    createField("kellyFraction", {
        parser: "kellyFraction",
        rustSupport: "unsupported",
        workerSupport: "ui_only",
    }),
    createField("kellyWinRateCap", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("kellyProfitFactorCap", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("volTargetAnnual", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("volLookbackBars", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("volScalingMethod", {
        parser: "volScalingMethod",
        rustSupport: "unsupported",
        workerSupport: "ui_only",
    }),
    createField("riskParityLookback", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("riskParityMethod", {
        parser: "riskParityMethod",
        rustSupport: "unsupported",
        workerSupport: "ui_only",
    }),
    createField("martingaleMultiplier", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("martingaleMaxSequence", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("martingaleResetOnWin", { parser: "boolean", rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("martingaleResetOnLoss", { parser: "boolean", rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("martingaleBaseSize", {
        parser: "martingaleBaseSize",
        rustSupport: "unsupported",
        workerSupport: "ui_only",
    }),
    createField("optimalFLookback", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("optimalFBootstrapSamples", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("secureFConfidence", { rustSupport: "unsupported", workerSupport: "ui_only" }),
    createField("secureFMethod", {
        parser: "secureFMethod",
        rustSupport: "unsupported",
        workerSupport: "ui_only",
    }),
    createField("useRustEngineToggle", {
        settingKey: "useRustEngine",
        parser: "boolean",
        legacyAliases: ["useRustEngine"],
        rustSupport: "ui_only",
        workerSupport: "ui_only",
    }),

    createField("riskSettingsToggle"),
    createField("riskMode", {
        parser: "riskMode",
        readFromSettings: (settings) => resolveRiskModeValue(settings.riskMode, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("atrPeriod"),
    createField("stopLossAtr"),
    createField("takeProfitAtr"),
    createField("trailingAtr"),
    createField("stopLossPercent"),
    createField("takeProfitPercent"),
    createField("takeProfitMode", {
        parser: "takeProfitMode",
        rustSupport: "conditional",
        readFromSettings: (settings) => resolveTakeProfitModeValue(settings.takeProfitMode, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("takeProfitMfeBootstrapPercentile", { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveLookbackTrades, { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveRecentWindow, { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveMinMultiplier, { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveMaxMultiplier, { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveGridSteps, { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveRegimeBlend, { rustSupport: "unsupported" }),
    createField(TAKE_PROFIT_DOM_IDS.takeProfitAdaptiveIcScale, { rustSupport: "unsupported" }),
    createField("stopLossToggle", {
        settingKey: "stopLossEnabled",
        parser: "boolean",
        legacyAliases: ["stopLossEnabled"],
    }),
    createField("takeProfitToggle", {
        settingKey: "takeProfitEnabled",
        parser: "boolean",
        legacyAliases: ["takeProfitEnabled"],
    }),
    createField("historicalLevelTakeProfitToggle", {
        settingKey: "historicalLevelTakeProfitEnabled",
        parser: "boolean",
        legacyAliases: ["historicalLevelTakeProfitEnabled"],
        rustSupport: "unsupported",
    }),
    createField("historicalLevelStopLossToggle", {
        settingKey: "historicalLevelStopLossEnabled",
        parser: "boolean",
        legacyAliases: ["historicalLevelStopLossEnabled"],
        rustSupport: "unsupported",
    }),
    createField("historicalLevelLookbackBars", { rustSupport: "unsupported" }),
    createField("riskMinHoldBars", { rustSupport: "unsupported" }),
    createField("riskMinHoldToggle", {
        settingKey: "riskMinHoldEnabled",
        parser: "boolean",
        legacyAliases: ["riskMinHoldEnabled"],
        rustSupport: "unsupported",
    }),
    createField("riskMaxHoldBars", { rustSupport: "unsupported" }),
    createField("riskMaxHoldToggle", {
        settingKey: "riskMaxHoldEnabled",
        parser: "boolean",
        legacyAliases: ["riskMaxHoldEnabled"],
        rustSupport: "unsupported",
    }),
    createField("disableSignalExits", { rustSupport: "unsupported" }),
    createField("exitStrategyOverrideEnabled", { rustSupport: "unsupported" }),
    createField("exitStrategyKey", { rustSupport: "unsupported" }),
    createField("exitStrategyParams", { rustSupport: "unsupported" }),
    createField("tradeDirection", {
        parser: "tradeDirection",
        rustSupport: "conditional",
        readFromSettings: (settings) => resolveTradeDirection(settings, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("invertSignalsToggle", {
        settingKey: "invertSignals",
        parser: "boolean",
        legacyAliases: ["invertSignals"],
        rustSupport: "unsupported",
    }),
    createField("flipAfterConsecutiveLosses", { rustSupport: "unsupported" }),
    createField("flipCooldownTrades", { rustSupport: "unsupported" }),
    createField("minTradesBeforeFirstFlip", { rustSupport: "unsupported" }),
    createField("confirmationStrategiesToggle", {
        parser: "boolean",
        rustSupport: "ui_only",
        workerSupport: "ui_only",
    }),
    createField("confirmationStrategies", {
        parser: "stringArray",
        rustSupport: "unsupported",
    }),
    createField("confirmationMode", {
        parser: "confirmationMode",
        rustSupport: "unsupported",
    }),
    createField("confirmationWindowBars", { rustSupport: "unsupported" }),
    createField("confirmationStrategyParams", {
        parser: "confirmationStrategyParams",
        rustSupport: "unsupported",
    }),

    createField("executionModel", {
        parser: "executionModel",
        rustSupport: "unsupported",
        readFromSettings: (settings) => resolveExecutionModelValue(settings.executionModel, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("slippageBps", { rustSupport: "unsupported" }),
    createField("maxOpenTrades", { rustSupport: "unsupported" }),
    createField("strategyTimeframeToggle", {
        settingKey: "strategyTimeframeEnabled",
        parser: "boolean",
        legacyAliases: ["strategyTimeframeEnabled"],
        rustSupport: "unsupported",
    }),
    createField("strategyTimeframeMinutes", { rustSupport: "unsupported" }),
    createField("polymarketAnnotationEnabled", { rustSupport: "unsupported" }),
    createField("polymarketOutcomeSymbol", { rustSupport: "unsupported", parser: "string" }),
    createField("polymarketOutcomeInterval", { rustSupport: "unsupported", parser: "polymarketOutcomeInterval" }),
    createField("polymarketEntrySelectionMode", { rustSupport: "unsupported", parser: "polymarketEntrySelectionMode" }),
    createField("polymarketEntryOffset", { rustSupport: "unsupported" }),
    createField("polymarketEntryDelayBars", { rustSupport: "unsupported", parser: "polymarketEntryDelayBars" }),
    createField("polymarketEntryPriceFilterCents", { rustSupport: "unsupported", parser: "polymarketEntryPriceFilterCents" }),
    createField("polymarketBacktestSlippageCents", { rustSupport: "unsupported", parser: "polymarketBacktestSlippageCents" }),
    createField("polymarketEntryCutoffToggle", {
        settingKey: "polymarketEntryCutoffEnabled",
        parser: "boolean",
        legacyAliases: ["polymarketEntryCutoffEnabled"],
        rustSupport: "unsupported",
    }),
    createField("polymarketEntryCutoffSeconds", { rustSupport: "unsupported" }),
    createField("polymarketExitMode", { rustSupport: "unsupported", parser: "polymarketExitMode" }),
    createField("polymarketSignalExitAllowMultipleTradesPerEvent", { rustSupport: "unsupported" }),
    createField("polymarketPostSignalLimitEntryEnabled", { rustSupport: "unsupported" }),
    createField("polymarketPostSignalLimitEntryMode", { rustSupport: "unsupported", parser: "polymarketLimitEntryMode" }),
    createField("polymarketPostSignalLimitEntryPriceCents", { rustSupport: "unsupported", parser: "polymarketLimitEntryPriceCents" }),
    createField("polymarketPostSignalLimitEntryOffsetCents", { rustSupport: "unsupported", parser: "polymarketLimitOffsetCents" }),
    createField("polymarketPostSignalLimitExitEnabled", { rustSupport: "unsupported" }),
    createField("polymarketPostSignalLimitExitMode", { rustSupport: "unsupported", parser: "polymarketLimitExitMode" }),
    createField("polymarketPostSignalLimitExitPriceCents", { rustSupport: "unsupported", parser: "polymarketLimitExitPriceCents" }),
    createField("polymarketPostSignalLimitExitOffsetCents", { rustSupport: "unsupported", parser: "polymarketLimitOffsetCents" }),
    createField("polymarketProtectionTakeProfitEnabled", { rustSupport: "unsupported" }),
    createField("polymarketProtectionTakeProfitCents", { rustSupport: "unsupported", parser: "polymarketProtectionCents" }),
    createField("polymarketProtectionStopLossEnabled", { rustSupport: "unsupported" }),
    createField("polymarketProtectionStopLossCents", { rustSupport: "unsupported", parser: "polymarketProtectionCents" }),
    createField("crossSymbolSecondary", {
        parser: "string",
        rustSupport: "unsupported",
        workerSupport: "unsupported",
    }),
];

export const BACKTEST_SETTINGS_DOM_CONTRACTS: readonly BacktestDomSettingContract[] = Object.freeze([
    ...BASE_BACKTEST_DOM_CONTRACTS,
]);

export const BACKTEST_SETTINGS_DOM_IDS: readonly string[] = Object.freeze(
    BACKTEST_SETTINGS_DOM_CONTRACTS.map((contract) => contract.domId)
);

const BACKTEST_SETTINGS_DOM_CONTRACT_MAP = new Map(
    BACKTEST_SETTINGS_DOM_CONTRACTS.map((contract) => [contract.domId, contract] as const)
);

function readNumericValue(value: unknown, fallback: number): number {
    return readNumber(value, fallback, { parseString: parseInputNumber });
}

function readBooleanValue(value: unknown, fallback: boolean): boolean {
    return readBoolean(value, fallback);
}

function readStringArrayValue(value: unknown): string[] {
    const source = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of source) {
        if (typeof item !== "string") continue;
        const normalized = item.trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }

    return result;
}

function readConfirmationStrategyParamsValue(value: unknown): Record<string, StrategyParams> {
    let source = value;
    if (typeof value === "string") {
        try {
            source = JSON.parse(value || "{}");
        } catch {
            return {};
        }
    }
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};

    const result: Record<string, StrategyParams> = {};
    for (const [strategyKey, rawParams] of Object.entries(source as Record<string, unknown>)) {
        if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) continue;

        const params: StrategyParams = {};
        for (const [paramKey, rawValue] of Object.entries(rawParams as Record<string, unknown>)) {
            const parsed = readNumericValue(rawValue, Number.NaN);
            if (Number.isFinite(parsed)) {
                params[paramKey] = parsed;
            }
        }
        if (Object.keys(params).length > 0) {
            result[strategyKey] = params;
        }
    }

    return result;
}

function readStrategyParamsValue(value: unknown): StrategyParams {
    let source = value;
    if (typeof value === "string") {
        try {
            source = JSON.parse(value || "{}");
        } catch {
            return {};
        }
    }
    if (!source || typeof source !== "object" || Array.isArray(source)) return {};

    const params: StrategyParams = {};
    for (const [paramKey, rawValue] of Object.entries(source as Record<string, unknown>)) {
        const parsed = readNumericValue(rawValue, Number.NaN);
        if (Number.isFinite(parsed)) {
            params[paramKey] = parsed;
        }
    }
    return params;
}

export function getBacktestDomSettingContract(domId: string): BacktestDomSettingContract | undefined {
    return BACKTEST_SETTINGS_DOM_CONTRACT_MAP.get(domId);
}

export function coerceBacktestDomSettingValue(
    contract: BacktestDomSettingContract,
    value: unknown
): unknown {
    switch (contract.parser) {
        case "tradeSizingMode":
            return resolveTradeSizingModeValue(value, DEFAULT_BACKTEST_SETTINGS);
        case "riskMode":
            return resolveRiskModeValue(value, DEFAULT_BACKTEST_SETTINGS);
        case "takeProfitMode":
            return resolveTakeProfitMode(value);
        case "tradeDirection":
            return resolveTradeDirection({ tradeDirection: value as any }, DEFAULT_BACKTEST_SETTINGS);
        case "marketMode":
            return resolveMarketMode({ marketMode: value as any }, DEFAULT_BACKTEST_SETTINGS);
        case "executionModel":
            return resolveExecutionModelValue(value, DEFAULT_BACKTEST_SETTINGS);
        case "polymarketOutcomeInterval":
            return resolvePolymarketOutcomeInterval(value);
        case "polymarketEntrySelectionMode":
            return resolvePolymarketEntrySelectionMode(value);
        case "polymarketEntryDelayBars":
            return clampPolymarketEntryDelayBars(value);
        case "polymarketEntryPriceFilterCents":
            return clampPolymarketEntryPriceFilterCents(value);
        case "polymarketBacktestSlippageCents":
            return clampPolymarketBacktestSlippageCents(value);
        case "polymarketExitMode":
            return resolvePolymarketExitMode(value);
        case "polymarketLimitEntryPriceCents":
            return clampPolymarketPostSignalLimitEntryPriceCents(value);
        case "polymarketLimitExitPriceCents":
            return clampPolymarketPostSignalLimitExitPriceCents(value);
        case "polymarketLimitOffsetCents":
            return clampPolymarketPostSignalLimitOffsetCents(value);
        case "polymarketLimitEntryMode":
            return resolvePolymarketPostSignalLimitEntryMode(value);
        case "polymarketLimitExitMode":
            return resolvePolymarketPostSignalLimitExitMode(value);
        case "polymarketProtectionCents":
            return clampPolymarketProtectionCents(value);
        case "kellyFraction":
            return resolveKellyFraction(value);
        case "volScalingMethod":
            return resolveVolScalingMethod(value);
        case "riskParityMethod":
            return resolveRiskParityMethod(value);
        case "martingaleBaseSize":
            return resolveMartingaleBaseSize(value);
        case "secureFMethod":
            return resolveSecureFMethod(value);
        case "boolean":
            return readBooleanValue(value, Boolean(contract.fallbackValue ?? (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[contract.settingKey] ?? false));
        case "string": {
            if (typeof value === "string") {
                return value.trim().toUpperCase();
            }
            const fallback = contract.fallbackValue ?? (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[contract.settingKey];
            return typeof fallback === "string" ? fallback : "";
        }
        case "stringArray":
            return readStringArrayValue(value);
        case "confirmationMode": {
            if (typeof value === "string") {
                const normalized = value.trim().toLowerCase();
                if (
                    normalized === "agree"
                    || normalized === "veto_opposite"
                    || normalized === "confirm_within_window"
                    || normalized === "veto_within_window"
                ) {
                    return normalized;
                }
            }
            return DEFAULT_BACKTEST_SETTINGS.confirmationMode;
        }
        case "confirmationStrategyParams":
            return readConfirmationStrategyParamsValue(value);
        case "strategyKey": {
            // Strategy keys are case-sensitive (e.g. rolling_vwap_center); do not uppercase.
            if (typeof value === "string") {
                return value.trim();
            }
            const keyFallback = contract.fallbackValue ?? (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[contract.settingKey];
            return typeof keyFallback === "string" ? keyFallback : "";
        }
        case "strategyParams":
            return readStrategyParamsValue(value);
        case "number": {
            const fallback = contract.fallbackValue ?? (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[contract.settingKey];
            return readNumericValue(value, typeof fallback === "number" ? fallback : 0);
        }
        default:
            return value;
    }
}

export function resolveBacktestDomSettingWriteValue(
    contract: BacktestDomSettingContract,
    settings: BacktestSettingsData
): unknown {
    if (contract.readFromSettings) {
        return contract.readFromSettings(settings);
    }
    return (settings as unknown as Record<string, unknown>)[contract.settingKey]
        ?? (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[contract.settingKey];
}
