import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingStdDev } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming initiative pressure can be modeled cleanly against its rolling standard deviation band.
// #SUGGEST_VERIFY: Verify standard deviation multiplier acts as a robust filter against high-whipsaw regimes.
function normalizeInitiativePressureRegimeIgnitionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        multiplier: Math.max(0.1, Number(params.multiplier ?? 2.0)),
    };
}

export const initiative_pressure_regime_ignition: Strategy = {
    name: "Initiative Pressure Regime Ignition",
    description: "Captures sudden expansion of initiative pressure relative to its average by standard deviation bands.",
    defaultParams: {
        lookback: 30,
        multiplier: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        multiplier: "Std Dev Multiplier",
    },
    normalizeParams: normalizeInitiativePressureRegimeIgnitionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureRegimeIgnitionParams(params);
        const lookback = p.lookback as number;
        const multiplier = p.multiplier as number;
        if (cleanData.length < lookback + 5) return [];

        const initiativePressure = buildInitiativePressureSeries(cleanData, lookback);
        
        // Coerce nulls to 0 to safely calculate rolling stats
        const scores = initiativePressure.map(v => v ?? 0);
        const avg = buildRollingAverage(scores, lookback);
        const stddev = buildRollingStdDev(scores, lookback);

        return createSignalLoop(cleanData, [initiativePressure, avg, stddev], (i) => {
            if (i < lookback) return null;
            const currentPressure = initiativePressure[i];
            const currentAvg = avg[i];
            const currentStddev = stddev[i];

            if (currentPressure === null || currentAvg === null || currentStddev === null) return null;

            const upperBand = currentAvg + multiplier * currentStddev;
            const lowerBand = currentAvg - multiplier * currentStddev;

            // Buy: Initiative pressure is positive and exceeds its rolling average by multiplier * rolling standard deviation
            if (currentPressure > 0 && currentPressure > upperBand) {
                return createBuySignal(cleanData, i, `Initiative Pressure Regime Bullish (pressure=${currentPressure.toFixed(3)}, upper=${upperBand.toFixed(3)})`);
            }

            // Sell: Initiative pressure is negative and falls below its rolling average by minus multiplier * rolling standard deviation
            if (currentPressure < 0 && currentPressure < lowerBand) {
                return createSellSignal(cleanData, i, `Initiative Pressure Regime Bearish (pressure=${currentPressure.toFixed(3)}, lower=${lowerBand.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "multiplier"],
    },
};
