import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming input parameters are sanitized and standard indicator arrays are computed correctly without future leaks.
// #SUGGEST_VERIFY: Check standard testing with manual array comparison and assert zero future leakage.
function normalizeEfficiencyIgnitionEarlyContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        minEfficiency: Math.max(0.01, Math.min(0.99, Number(params.minEfficiency ?? 0.65))),
    };
}

export const efficiency_ignition_early_continuation: Strategy = {
    name: "Efficiency Ignition Early Continuation",
    description: "Captures early momentum ignition when path efficiency surges from a compressed baseline, signaling institutional consolidation breakouts.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        minEfficiency: "Min Efficiency",
    },
    normalizeParams: normalizeEfficiencyIgnitionEarlyContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyIgnitionEarlyContinuationParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [efficiency, median], (i) => {
            const currentClose = closes[i];
            const prevClose = closes[i - 1];
            const currentMedian = median[i];
            const prevMedian = median[i - 1];
            const eff = efficiency[i];

            if (currentMedian === null || prevMedian === null || eff === null) return null;
            if (eff <= p.minEfficiency) return null;

            // Bullish: close crosses above rolling median
            if (prevClose <= prevMedian && currentClose > currentMedian) {
                return createBuySignal(cleanData, i, `Efficiency Ignition Crossover Above Median (eff=${eff.toFixed(3)})`);
            }
            // Bearish: close crosses below rolling median
            if (prevClose >= prevMedian && currentClose < currentMedian) {
                return createSellSignal(cleanData, i, `Efficiency Ignition Crossover Below Median (eff=${eff.toFixed(3)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency"],
    },
};
