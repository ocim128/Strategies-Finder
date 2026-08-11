import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation, buildRollingMedian } from "./price-action-statistics-core";

const CLUSTERING_LEVEL = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const range_autocorrelation_expansion_follow: Strategy = {
    name: "Range Autocorrelation Expansion Follow",
    description: "Follows expansions above the median range when range autocorrelation certifies a persisting volatility regime.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Volatility Regime Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangeAC = buildRollingAutoCorrelation(ranges, lookback, 1);
        const medianRange = buildRollingMedian(ranges, lookback);

        return createSignalLoop(cleanData, [rangeAC, medianRange], (i) => {
            const ac = rangeAC[i];
            const med = medianRange[i];
            if (ac === null || med === null) return null;

            // Volatility persists (positive range autocorrelation) and the bar
            // expands beyond the median range: regime-consistent expansion.
            if (ac > CLUSTERING_LEVEL && ranges[i] > med && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Range clustering buy: ac ${ac.toFixed(2)}, expansion above median range ${med.toFixed(4)}`);
            }
            if (ac > CLUSTERING_LEVEL && ranges[i] > med && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Range clustering sell: ac ${ac.toFixed(2)}, expansion above median range ${med.toFixed(4)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
