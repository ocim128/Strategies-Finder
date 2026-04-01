import {
    ADVANCED_SIZING_BOOLEAN_FIELD_IDS,
    ADVANCED_SIZING_FIELD_IDS,
    ADVANCED_SIZING_NUMERIC_FIELD_IDS,
} from "./advanced-sizing-dom";
import { readBoolean, readNumber, toBooleanLike, toFiniteNumber } from "./settings-parse-utils";
import type { AdvancedSizingSettings } from "./types/backtest";

export const ADVANCED_SIZING_DEFAULTS: Readonly<Required<AdvancedSizingSettings>> = Object.freeze({
    kellyFraction: "half",
    kellyWinRateCap: 0.7,
    kellyProfitFactorCap: 1.2,
    volTargetAnnual: 0.15,
    volLookbackBars: 60,
    volScalingMethod: "ewma",
    riskParityLookback: 100,
    riskParityMethod: "historical_std",
    martingaleMultiplier: 2,
    martingaleMaxSequence: 4,
    martingaleResetOnWin: true,
    martingaleResetOnLoss: false,
    martingaleBaseSize: "fixed",
    optimalFLookback: 100,
    optimalFBootstrapSamples: 250,
    secureFConfidence: 0.95,
    secureFMethod: "bootstrap",
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveKellyFraction(value: unknown): AdvancedSizingSettings["kellyFraction"] {
    return value === "full" || value === "quarter" ? value : ADVANCED_SIZING_DEFAULTS.kellyFraction;
}

export function resolveVolScalingMethod(value: unknown): AdvancedSizingSettings["volScalingMethod"] {
    return value === "sma" || value === "expanding" ? value : ADVANCED_SIZING_DEFAULTS.volScalingMethod;
}

export function resolveRiskParityMethod(value: unknown): AdvancedSizingSettings["riskParityMethod"] {
    return value === "var" || value === "expected_shortfall" ? value : ADVANCED_SIZING_DEFAULTS.riskParityMethod;
}

export function resolveMartingaleBaseSize(value: unknown): AdvancedSizingSettings["martingaleBaseSize"] {
    return value === "percent" ? value : ADVANCED_SIZING_DEFAULTS.martingaleBaseSize;
}

export function resolveSecureFMethod(value: unknown): AdvancedSizingSettings["secureFMethod"] {
    return value === "analytical" ? value : ADVANCED_SIZING_DEFAULTS.secureFMethod;
}

export function createDefaultAdvancedSizingSettings(): AdvancedSizingSettings {
    return { ...ADVANCED_SIZING_DEFAULTS };
}

export function resolveAdvancedSizingSettings(raw?: Record<string, unknown> | null): AdvancedSizingSettings {
    const source = isRecord(raw?.advancedSizing) ? raw.advancedSizing : raw;

    return {
        kellyFraction: resolveKellyFraction(source?.kellyFraction),
        kellyWinRateCap: Math.max(0.5, Math.min(0.95, readNumber(source?.kellyWinRateCap, ADVANCED_SIZING_DEFAULTS.kellyWinRateCap))),
        kellyProfitFactorCap: Math.max(0.5, readNumber(source?.kellyProfitFactorCap, ADVANCED_SIZING_DEFAULTS.kellyProfitFactorCap)),
        volTargetAnnual: Math.max(0.01, Math.min(2, readNumber(source?.volTargetAnnual, ADVANCED_SIZING_DEFAULTS.volTargetAnnual))),
        volLookbackBars: Math.max(5, Math.round(readNumber(source?.volLookbackBars, ADVANCED_SIZING_DEFAULTS.volLookbackBars))),
        volScalingMethod: resolveVolScalingMethod(source?.volScalingMethod),
        riskParityLookback: Math.max(5, Math.round(readNumber(source?.riskParityLookback, ADVANCED_SIZING_DEFAULTS.riskParityLookback))),
        riskParityMethod: resolveRiskParityMethod(source?.riskParityMethod),
        martingaleMultiplier: Math.max(1, readNumber(source?.martingaleMultiplier, ADVANCED_SIZING_DEFAULTS.martingaleMultiplier)),
        martingaleMaxSequence: Math.max(0, Math.round(readNumber(source?.martingaleMaxSequence, ADVANCED_SIZING_DEFAULTS.martingaleMaxSequence))),
        martingaleResetOnWin: readBoolean(source?.martingaleResetOnWin, ADVANCED_SIZING_DEFAULTS.martingaleResetOnWin),
        martingaleResetOnLoss: readBoolean(source?.martingaleResetOnLoss, ADVANCED_SIZING_DEFAULTS.martingaleResetOnLoss),
        martingaleBaseSize: resolveMartingaleBaseSize(source?.martingaleBaseSize),
        optimalFLookback: Math.max(10, Math.round(readNumber(source?.optimalFLookback, ADVANCED_SIZING_DEFAULTS.optimalFLookback))),
        optimalFBootstrapSamples: Math.max(10, Math.round(readNumber(source?.optimalFBootstrapSamples, ADVANCED_SIZING_DEFAULTS.optimalFBootstrapSamples))),
        secureFConfidence: Math.max(0.5, Math.min(0.999, readNumber(source?.secureFConfidence, ADVANCED_SIZING_DEFAULTS.secureFConfidence))),
        secureFMethod: resolveSecureFMethod(source?.secureFMethod),
    };
}

export function extractAdvancedSizingRaw(raw: Record<string, unknown>): Record<string, unknown> {
    const extracted: Record<string, unknown> = {};

    for (const key of ADVANCED_SIZING_FIELD_IDS) {
        const value = raw[key];
        if (value !== undefined) {
            extracted[key] = value;
        }
    }

    if (isRecord(raw.advancedSizing)) {
        for (const key of ADVANCED_SIZING_FIELD_IDS) {
            const value = raw.advancedSizing[key];
            if (value !== undefined && extracted[key] === undefined) {
                extracted[key] = value;
            }
        }
    }

    return extracted;
}

export function writeAdvancedSizingIntoRecord(
    target: Record<string, unknown>,
    advancedSizing?: AdvancedSizingSettings
): void {
    const resolved = advancedSizing ? resolveAdvancedSizingSettings(advancedSizing as Record<string, unknown>) : createDefaultAdvancedSizingSettings();
    for (const key of ADVANCED_SIZING_FIELD_IDS) {
        target[key] = resolved[key];
    }
}

export function coerceAdvancedSizingFieldValue(key: keyof AdvancedSizingSettings, value: unknown): unknown {
    if (ADVANCED_SIZING_NUMERIC_FIELD_IDS.has(key)) {
        return toFiniteNumber(value) ?? (ADVANCED_SIZING_DEFAULTS[key] as number);
    }
    if (ADVANCED_SIZING_BOOLEAN_FIELD_IDS.has(key)) {
        return toBooleanLike(value) ?? (ADVANCED_SIZING_DEFAULTS[key] as boolean);
    }
    switch (key) {
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
        default:
            return value;
    }
}
