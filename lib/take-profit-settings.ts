import { toFiniteNumber } from "./settings-parse-utils";
import type { PercentageTakeProfitMode } from "./types/strategies";

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
