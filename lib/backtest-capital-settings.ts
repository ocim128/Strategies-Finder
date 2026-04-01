import { CAPITAL_DEFAULTS } from "./backtest-settings-resolver";
import { toBooleanLike, toFiniteNumber } from "./settings-parse-utils";
import { extractAdvancedSizingRaw, resolveAdvancedSizingSettings } from "./advanced-sizing-settings";
import { isTradeSizingMode, type CapitalSettings, type TradeSizingMode } from "./types/backtest";

export const DEFAULT_CAPITAL_SETTINGS_INPUT = Object.freeze({
    initialCapital: CAPITAL_DEFAULTS.initialCapital,
    positionSize: CAPITAL_DEFAULTS.positionSize,
    commission: CAPITAL_DEFAULTS.commission,
    fixedTradeAmount: CAPITAL_DEFAULTS.fixedTradeAmount,
    sizingMode: "percent" as TradeSizingMode,
});

export const SUBSCRIPTION_CAPITAL_LEGACY_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    fixedTradeAmount: 0,
    sizingMode: "percent" as TradeSizingMode,
});

export interface CapitalSettingsRaw {
    initialCapital?: unknown;
    positionSize?: unknown;
    commission?: unknown;
    fixedTradeAmount?: unknown;
    sizingMode?: unknown;
    fixedTradeToggle?: unknown;
    advancedSizing?: unknown;
    [key: string]: unknown;
}

export interface CapitalSettingsDefaults {
    initialCapital: number;
    positionSize: number;
    commission: number;
    fixedTradeAmount: number;
    sizingMode: TradeSizingMode;
}

export function normalizeTradeSizingMode(value: unknown): TradeSizingMode | null {
    if (value === "smart_fixed") return "smart_fixed_velocity_memory";
    if (
        value === "smart_fixed_early_heat_filter"
        || value === "smart_fixed_adverse_memory"
        || value === "smart_fixed_mfe_ancestor"
        || value === "smart_fixed_tp_distance_fit"
    ) {
        return "smart_fixed_quality_x_velocity";
    }
    return isTradeSizingMode(value) ? value : null;
}

export function resolveCapitalSettingsFromRaw(
    raw: CapitalSettingsRaw,
    defaults: CapitalSettingsDefaults = DEFAULT_CAPITAL_SETTINGS_INPUT
): CapitalSettings {
    const explicitSizingMode = normalizeTradeSizingMode(raw.sizingMode);
    const fixedTradeToggle = toBooleanLike(raw.fixedTradeToggle);
    const sizingMode: TradeSizingMode = explicitSizingMode
        ?? (fixedTradeToggle === true ? "fixed" : defaults.sizingMode);

    return {
        initialCapital: Math.max(0, toFiniteNumber(raw.initialCapital) ?? defaults.initialCapital),
        positionSize: Math.max(0, toFiniteNumber(raw.positionSize) ?? defaults.positionSize),
        commission: Math.max(0, toFiniteNumber(raw.commission) ?? defaults.commission),
        sizingMode,
        fixedTradeAmount: Math.max(0, toFiniteNumber(raw.fixedTradeAmount) ?? defaults.fixedTradeAmount),
        advancedSizing: resolveAdvancedSizingSettings(extractAdvancedSizingRaw(raw)),
    };
}
