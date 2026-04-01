import { ADVANCED_SIZING_DEFAULTS } from "../../advanced-sizing-settings";
import type { AdvancedSizingSettings, VolScalingMethod } from "../../types/backtest";
import type { OHLCVData } from "../../types/strategies";
import { average, buildCloseReturns, clamp, inferBarsPerYear } from "./shared";

export interface VolTargetingState {
    currentVolAnnualized: number;
}

function calculateStandardDeviation(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const mean = average(values);
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    return Math.sqrt(Math.max(0, variance));
}

export function calculateVolatility(
    returns: number[],
    method: VolScalingMethod,
    lookback: number
): number {
    const sample = method === "expanding" ? returns : returns.slice(-Math.max(1, lookback));
    if (sample.length === 0) return 0;
    if (method === "ewma") {
        const decay = 0.94;
        let variance = sample[0] ** 2;
        for (let i = 1; i < sample.length; i++) {
            variance = decay * variance + (1 - decay) * (sample[i] ** 2);
        }
        return Math.sqrt(Math.max(0, variance));
    }
    return calculateStandardDeviation(sample);
}

export function resolveVolTargetingMultiplier(
    data: OHLCVData[],
    endIndex: number,
    settings?: AdvancedSizingSettings
): number {
    const lookbackBars = settings?.volLookbackBars ?? ADVANCED_SIZING_DEFAULTS.volLookbackBars;
    const returns = buildCloseReturns(data, endIndex, lookbackBars);
    if (returns.length < 2) return 1;

    const currentVol = calculateVolatility(
        returns,
        settings?.volScalingMethod ?? ADVANCED_SIZING_DEFAULTS.volScalingMethod,
        lookbackBars
    );
    if (!Number.isFinite(currentVol) || currentVol <= 0) {
        return 1;
    }

    const currentAnnualizedVol = currentVol * Math.sqrt(inferBarsPerYear(data, endIndex));
    const targetAnnualVol = settings?.volTargetAnnual ?? ADVANCED_SIZING_DEFAULTS.volTargetAnnual;
    return clamp(targetAnnualVol / currentAnnualizedVol, 0.25, 3);
}
