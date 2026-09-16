import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildExtremeAgeSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 26))),
    };
}

export const extreme_age_rapid_inversion_pivot: Strategy = {
    name: "Extreme Age Rapid Inversion Pivot",
    description: "Rides structural trend reversals when price traverses across the entire range to flip an ancient boundary to fresh high within 2 bars.",
    defaultParams: {
        lookback: 26,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const staleMin = Math.round(lookback * 0.75);

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 2) return null;
            const priorHighAge = sinceHigh[i - 2];
            const currHighAge = sinceHigh[i];
            const priorLowAge = sinceLow[i - 2];
            const currLowAge = sinceLow[i];

            if (priorHighAge !== null && priorHighAge >= staleMin && currHighAge === 0) {
                return createBuySignal(cleanData, i, `Bullish rapid inversion: prior high age ${priorHighAge} >= ${staleMin} inverted to fresh high 0 in 2 bars`);
            }
            if (priorLowAge !== null && priorLowAge >= staleMin && currLowAge === 0) {
                return createSellSignal(cleanData, i, `Bearish rapid inversion: prior low age ${priorLowAge} >= ${staleMin} inverted to fresh low 0 in 2 bars`);
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
