import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingCorrelation } from "./price-action-statistics-core";

const TREND_GATE = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const trend_slope_strength_follow: Strategy = {
    name: "Trend Slope Strength",
    description: "Trades the rolling correlation of closes with the bar index, the scale-free steepness of the trend line.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Trend Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        // Build the index series once so the correlation cache key is stable.
        const idx = closes.map((_, j) => j);
        const corr = buildRollingCorrelation(closes, idx, lookback);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null) return null;

            if (c >= TREND_GATE) {
                return createBuySignal(cleanData, i, `Clean uptrend slope: corr ${c.toFixed(2)}`);
            }
            if (c <= -TREND_GATE) {
                return createSellSignal(cleanData, i, `Clean downtrend slope: corr ${c.toFixed(2)}`);
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
