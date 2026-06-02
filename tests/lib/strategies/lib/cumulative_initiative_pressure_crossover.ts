import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming initiative pressure decayed cumulative crossovers capture short-term microstructure shifts correctly.
// #SUGGEST_VERIFY: Verify cumulative decay handles zero or extreme volume spikes without overflow or instability.
function normalizeCumulativeInitiativePressureCrossoverParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        decay: Math.max(0.01, Math.min(0.999, Number(params.decay ?? 0.92))),
    };
}

export const cumulative_initiative_pressure_crossover: Strategy = {
    name: "Cumulative Initiative Pressure Crossover",
    description: "Captures critical turning points in buy/sell pressure imbalance when decayed cumulative initiative pressure crosses its rolling average.",
    defaultParams: {
        lookback: 40,
        decay: 0.92,
    },
    paramLabels: {
        lookback: "Lookback Window",
        decay: "Decay Factor",
    },
    normalizeParams: normalizeCumulativeInitiativePressureCrossoverParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCumulativeInitiativePressureCrossoverParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const scores = initiative.map(v => v ?? 0);
        const decayed = buildCumulativeDecaySum(scores, p.decay as number);
        const avg = buildRollingAverage(decayed, lookback);

        return createSignalLoop(cleanData, [initiative, avg], (i) => {
            if (i < lookback) return null;
            const currentDecayed = decayed[i];
            const prevDecayed = decayed[i - 1];
            const currentAvg = avg[i];
            const prevAvg = avg[i - 1];

            if (currentAvg === null || prevAvg === null) return null;

            // Buy logic: Decayed cumulative initiative pressure crosses above its rolling average
            if (prevDecayed <= prevAvg && currentDecayed > currentAvg) {
                return createBuySignal(cleanData, i, `Initiative Decay Cumulative Crossover Bullish (decayed=${currentDecayed.toFixed(3)}, avg=${currentAvg.toFixed(3)})`);
            }

            // Sell logic: Decayed cumulative initiative pressure crosses below its rolling average
            if (prevDecayed >= prevAvg && currentDecayed < currentAvg) {
                return createSellSignal(cleanData, i, `Initiative Decay Cumulative Crossover Bearish (decayed=${currentDecayed.toFixed(3)}, avg=${currentAvg.toFixed(3)})`);
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
