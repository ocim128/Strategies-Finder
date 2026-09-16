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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 32))),
    };
}

export const extreme_age_dual_stale_coil_release: Strategy = {
    name: "Extreme Age Dual Stale Coil Release",
    description: "Enters explosive trend runs when price breaks out of a compression box where both high and low extremes are ancient.",
    defaultParams: {
        lookback: 32,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const { sinceHigh, sinceLow } = buildExtremeAgeSeries(cleanData, lookback);
        const staleMin = lookback - 3;

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const prevHighAge = sinceHigh[i - 1];
            const prevLowAge = sinceLow[i - 1];
            const currHighAge = sinceHigh[i];
            const currLowAge = sinceLow[i];

            const wasDualStale = prevHighAge !== null && prevLowAge !== null && prevHighAge >= staleMin && prevLowAge >= staleMin;
            if (!wasDualStale) return null;

            if (currHighAge === 0) {
                return createBuySignal(cleanData, i, `Bullish dual stale coil release: both extremes aged >= ${staleMin}, high reset to 0`);
            }
            if (currLowAge === 0) {
                return createSellSignal(cleanData, i, `Bearish dual stale coil release: both extremes aged >= ${staleMin}, low reset to 0`);
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
