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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 24))),
    };
}

export const extreme_age_consecutive_fresh_snowball: Strategy = {
    name: "Extreme Age Consecutive Fresh Snowball",
    description: "Rides runaway trend momentum when consecutive 4H bars each print brand new window extremes (age 0 on back-to-back bars).",
    defaultParams: {
        lookback: 24,
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

        return createSignalLoop(cleanData, [sinceHigh, sinceLow], (i) => {
            if (i < 1) return null;
            const prevH = sinceHigh[i - 1];
            const currH = sinceHigh[i];
            const prevL = sinceLow[i - 1];
            const currL = sinceLow[i];

            if (prevH !== null && currH !== null && prevH === 0 && currH === 0) {
                return createBuySignal(cleanData, i, "Bullish fresh snowball: back-to-back bars printed age 0 new high");
            }
            if (prevL !== null && currL !== null && prevL === 0 && currL === 0) {
                return createSellSignal(cleanData, i, "Bearish fresh snowball: back-to-back bars printed age 0 new low");
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
