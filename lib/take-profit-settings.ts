import { TAKE_PROFIT_FIELD_IDS } from "./take-profit-dom";
import { readNumber, toFiniteNumber } from "./settings-parse-utils";
import type { BacktestSettings, PercentageTakeProfitMode } from "./types/strategies";

export const ADAPTIVE_TAKE_PROFIT_DEFAULTS = Object.freeze({
    takeProfitAdaptiveLookbackTrades: 40,
    takeProfitAdaptiveRecentWindow: 12,
    takeProfitAdaptiveMinMultiplier: 0.75,
    takeProfitAdaptiveMaxMultiplier: 1.5,
    takeProfitAdaptiveGridSteps: 7,
    takeProfitAdaptiveRegimeBlend: 0.6,
    takeProfitAdaptiveIcScale: 0.5,
} as const);

export function resolveTakeProfitMode(value: unknown): PercentageTakeProfitMode {
    switch (value) {
        case "mfe_bootstrap":
        case "edge_weighted":
        case "expectancy_optimal":
        case "regime_calibrated":
        case "information_coefficient":
        case "path_efficiency":
        case "serial_dependency":
        case "minimum_surprisal":
            return value;
        default:
            return "fixed";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveAdaptiveTakeProfitSettings(
    raw?: Record<string, unknown> | null
): Pick<BacktestSettings,
    | "takeProfitAdaptiveLookbackTrades"
    | "takeProfitAdaptiveRecentWindow"
    | "takeProfitAdaptiveMinMultiplier"
    | "takeProfitAdaptiveMaxMultiplier"
    | "takeProfitAdaptiveGridSteps"
    | "takeProfitAdaptiveRegimeBlend"
    | "takeProfitAdaptiveIcScale"
> {
    const source = isRecord(raw?.adaptiveTakeProfit) ? raw.adaptiveTakeProfit : raw;

    return {
        takeProfitAdaptiveLookbackTrades: Math.max(
            5,
            Math.round(readNumber(source?.takeProfitAdaptiveLookbackTrades, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveLookbackTrades))
        ),
        takeProfitAdaptiveRecentWindow: Math.max(
            3,
            Math.round(readNumber(source?.takeProfitAdaptiveRecentWindow, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveRecentWindow))
        ),
        takeProfitAdaptiveMinMultiplier: Math.max(
            0.1,
            readNumber(source?.takeProfitAdaptiveMinMultiplier, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveMinMultiplier)
        ),
        takeProfitAdaptiveMaxMultiplier: Math.max(
            0.2,
            readNumber(source?.takeProfitAdaptiveMaxMultiplier, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveMaxMultiplier)
        ),
        takeProfitAdaptiveGridSteps: Math.max(
            3,
            Math.round(readNumber(source?.takeProfitAdaptiveGridSteps, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveGridSteps))
        ),
        takeProfitAdaptiveRegimeBlend: Math.max(
            0,
            Math.min(1, readNumber(source?.takeProfitAdaptiveRegimeBlend, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveRegimeBlend))
        ),
        takeProfitAdaptiveIcScale: Math.max(
            0,
            Math.min(2, readNumber(source?.takeProfitAdaptiveIcScale, ADAPTIVE_TAKE_PROFIT_DEFAULTS.takeProfitAdaptiveIcScale))
        ),
    };
}

export function extractAdaptiveTakeProfitRaw(raw: Record<string, unknown>): Record<string, unknown> {
    const extracted: Record<string, unknown> = {};

    for (const key of TAKE_PROFIT_FIELD_IDS) {
        const value = raw[key];
        if (value !== undefined) {
            extracted[key] = value;
        }
    }

    if (isRecord(raw.adaptiveTakeProfit)) {
        for (const key of TAKE_PROFIT_FIELD_IDS) {
            const value = raw.adaptiveTakeProfit[key];
            if (value !== undefined && extracted[key] === undefined) {
                extracted[key] = value;
            }
        }
    }

    return extracted;
}

export function coerceAdaptiveTakeProfitFieldValue(
    key: keyof typeof ADAPTIVE_TAKE_PROFIT_DEFAULTS,
    value: unknown
): number {
    const numeric = toFiniteNumber(value) ?? ADAPTIVE_TAKE_PROFIT_DEFAULTS[key];
    switch (key) {
        case "takeProfitAdaptiveLookbackTrades":
            return Math.max(5, Math.round(numeric));
        case "takeProfitAdaptiveRecentWindow":
            return Math.max(3, Math.round(numeric));
        case "takeProfitAdaptiveMinMultiplier":
            return Math.max(0.1, numeric);
        case "takeProfitAdaptiveMaxMultiplier":
            return Math.max(0.2, numeric);
        case "takeProfitAdaptiveGridSteps":
            return Math.max(3, Math.round(numeric));
        case "takeProfitAdaptiveRegimeBlend":
            return Math.max(0, Math.min(1, numeric));
        case "takeProfitAdaptiveIcScale":
            return Math.max(0, Math.min(2, numeric));
        default:
            return numeric;
    }
}
