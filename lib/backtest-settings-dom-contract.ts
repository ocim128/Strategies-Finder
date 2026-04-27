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
    resolveTradeFilterMode,
    resolveTradeFilterModeValue,
    resolveTradeFilterToggle,
    resolveTradeSizingModeValue,
    type BacktestSettingsData,
} from "./settings-model";
import { resolvePolymarketEntrySelectionMode } from "./polymarket-entry-selection-mode";
import { resolvePolymarketOutcomeInterval } from "./polymarket-outcome-interval";
import { RUST_UNSUPPORTED_BACKTEST_SETTING_KEYS } from "./rust-settings-sanitizer";
import { resolveTakeProfitMode } from "./take-profit-settings";
import type { BacktestSettings } from "./types/strategies";

export type BacktestDomSettingKey = keyof BacktestSettingsData | "entrySettingsToggle";
export type BacktestDomSettingParser =
    | "number"
    | "boolean"
    | "string"
    | "polymarketOutcomeInterval"
    | "polymarketEntrySelectionMode"
    | "polymarketExitMode"
    | "riskMode"
    | "takeProfitMode"
    | "tradeFilterMode"
    | "tradeDirection"
    | "marketMode"
    | "executionModel"
    | "tradeSizingMode"
    | "kellyFraction"
    | "volScalingMethod"
    | "riskParityMethod"
    | "martingaleBaseSize"
    | "secureFMethod";

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
        case "tradeFilterMode":
            return "tradeFilterMode";
        case "tradeDirection":
            return "tradeDirection";
        case "marketMode":
            return "marketMode";
        case "executionModel":
            return "executionModel";
        case "sizingMode":
            return "tradeSizingMode";
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
        case "entrySettingsToggle":
            return "boolean";
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
    if (settingKey === "tradeFilterMode" || settingKey === "tradeDirection" || settingKey === "marketMode" || settingKey === "takeProfitMode") {
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
    createField("partialTakeProfitAtR"),
    createField("partialTakeProfitPercent"),
    createField("breakEvenAtR"),
    createField("breakEvenPercent"),
    createField("timeStopBars"),
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
    createField("riskMaxHoldBars", { rustSupport: "unsupported" }),
    createField("riskMaxHoldToggle", {
        settingKey: "riskMaxHoldEnabled",
        parser: "boolean",
        legacyAliases: ["riskMaxHoldEnabled"],
        rustSupport: "unsupported",
    }),
    createField("riskWinStreakStopLossToggle", {
        settingKey: "riskWinStreakStopLossEnabled",
        parser: "boolean",
        legacyAliases: ["riskWinStreakStopLossEnabled"],
        rustSupport: "unsupported",
    }),
    createField("riskWinStreakStopLossAfterWins", { rustSupport: "unsupported" }),
    createField("riskWinStreakStopLossPercent", { rustSupport: "unsupported" }),
    createField("marketMode", {
        parser: "marketMode",
        rustSupport: "conditional",
        readFromSettings: (settings) => resolveMarketMode(settings, DEFAULT_BACKTEST_SETTINGS),
    }),

    createField("tradeFilterSettingsToggle", {
        parser: "boolean",
        legacyAliases: ["entrySettingsToggle"],
        readFromSettings: (settings) => resolveTradeFilterToggle(settings, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("entrySettingsToggle", {
        parser: "boolean",
        legacyAliases: ["tradeFilterSettingsToggle"],
        fallbackValue: false,
        readFromSettings: (settings) => settings.entrySettingsToggle ?? resolveTradeFilterToggle(settings, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("tradeFilterMode", {
        parser: "tradeFilterMode",
        legacyAliases: ["entryConfirmation"],
        rustSupport: "conditional",
        readFromSettings: (settings) => resolveTradeFilterMode(settings, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("htfBiasEmaPeriod"),
    createField("executionTrendEmaPeriod", { rustSupport: "unsupported" }),
    createField("confirmLookback"),
    createField("volumeSmaPeriod"),
    createField("volumeMultiplier"),
    createField("confirmRsiPeriod", {
        legacyAliases: ["rsiPeriod"],
    }),
    createField("confirmRsiBullish", {
        legacyAliases: ["rsiBullish"],
    }),
    createField("confirmRsiBearish", {
        legacyAliases: ["rsiBearish"],
    }),

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

    createField("executionModel", {
        parser: "executionModel",
        rustSupport: "unsupported",
        readFromSettings: (settings) => resolveExecutionModelValue(settings.executionModel, DEFAULT_BACKTEST_SETTINGS),
    }),
    createField("allowSameBarExitToggle", {
        settingKey: "allowSameBarExit",
        parser: "boolean",
        legacyAliases: ["allowSameBarExit"],
        rustSupport: "unsupported",
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
    createField("polymarketExitMode", { rustSupport: "unsupported", parser: "polymarketExitMode" }),
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
        case "tradeFilterMode":
            return resolveTradeFilterModeValue(value, DEFAULT_BACKTEST_SETTINGS);
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
        case "polymarketExitMode":
            return typeof value === "string" && value.trim().toLowerCase() === "signal_exit_same_event"
                ? "signal_exit_same_event"
                : "resolve_hold";
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
