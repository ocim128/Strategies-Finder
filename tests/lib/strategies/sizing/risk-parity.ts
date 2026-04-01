import { ADVANCED_SIZING_DEFAULTS } from "../../advanced-sizing-settings";
import type { AdvancedSizingSettings } from "../../types/backtest";
import type { OHLCVData } from "../../types/strategies";
import { buildCloseReturns, clamp, percentile } from "./shared";

function calculateHistoricalStd(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
    return Math.sqrt(Math.max(0, variance));
}

function calculateValueAtRisk(returns: number[]): number {
    if (returns.length === 0) return 0;
    return Math.abs(percentile(returns, 0.05));
}

function calculateExpectedShortfall(returns: number[]): number {
    if (returns.length === 0) return 0;
    const threshold = percentile(returns, 0.05);
    const tail = returns.filter((value) => value <= threshold);
    if (tail.length === 0) return Math.abs(threshold);
    return Math.abs(tail.reduce((sum, value) => sum + value, 0) / tail.length);
}

export function resolveRiskParityMultiplier(
    data: OHLCVData[],
    endIndex: number,
    settings?: AdvancedSizingSettings
): number {
    const lookbackBars = settings?.riskParityLookback ?? ADVANCED_SIZING_DEFAULTS.riskParityLookback;
    const returns = buildCloseReturns(data, endIndex, lookbackBars);
    if (returns.length < 2) return 1;

    const method = settings?.riskParityMethod ?? ADVANCED_SIZING_DEFAULTS.riskParityMethod;
    const riskMeasure = method === "var"
        ? calculateValueAtRisk(returns)
        : method === "expected_shortfall"
            ? calculateExpectedShortfall(returns)
            : calculateHistoricalStd(returns);

    if (!Number.isFinite(riskMeasure) || riskMeasure <= 0) {
        return 1;
    }

    const targetRiskContribution = 0.01;
    return clamp(targetRiskContribution / riskMeasure, 0.25, 3);
}
