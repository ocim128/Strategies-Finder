import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming initiative pressure can be modeled as decayed cumulative sum safely and crossover maps correctly.
// #SUGGEST_VERIFY: Verify cumulative decay output doesn't overflow and handles early null bounds cleanly.
function normalizeInitiativePressureAccelerationEntryParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.94))),
    };
}

export const initiative_pressure_acceleration_entry: Strategy = {
    name: "Initiative Pressure Acceleration Entry",
    description: "Captures aggressive transaction flows exhibiting high acceleration at the onset of a new trend via decayed cumulative initiative pressure crossovers.",
    defaultParams: {
        lookback: 40,
        decay: 0.94,
    },
    paramLabels: {
        lookback: "Lookback Window",
        decay: "Decay Factor",
    },
    normalizeParams: normalizeInitiativePressureAccelerationEntryParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeInitiativePressureAccelerationEntryParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const initiativePressure = buildInitiativePressureSeries(cleanData, lookback);
        
        // Coerce nulls to 0 to safely pass to buildCumulativeDecaySum
        const scores = initiativePressure.map(v => v ?? 0);
        const decayed = buildCumulativeDecaySum(scores, p.decay as number);
        
        const avg = buildRollingAverage(decayed, lookback);

        return createSignalLoop(cleanData, [initiativePressure, avg], (i) => {
            if (i < lookback) return null;
            const currentPressure = initiativePressure[i];
            const currentDecayed = decayed[i];
            const prevDecayed = decayed[i - 1];
            const currentAvg = avg[i];
            const prevAvg = avg[i - 1];

            if (currentPressure === null || currentAvg === null || prevAvg === null) return null;

            // Bullish crossover: decayed cumulative pressure crosses above its rolling average
            if (prevDecayed <= prevAvg && currentDecayed > currentAvg && currentPressure > 0) {
                return createBuySignal(cleanData, i, `Initiative Pressure Acceleration Crossover Bullish (pressure=${currentPressure.toFixed(3)})`);
            }

            // Bearish crossover: decayed cumulative pressure crosses below its rolling average
            if (prevDecayed >= prevAvg && currentDecayed < currentAvg && currentPressure < 0) {
                return createSellSignal(cleanData, i, `Initiative Pressure Acceleration Crossover Bearish (pressure=${currentPressure.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "decay"],
    },
};
