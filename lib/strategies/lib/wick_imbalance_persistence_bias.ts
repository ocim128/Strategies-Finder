import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingMedian } from "./price-action-statistics-core";

const BIAS_BAND = 0.15;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const wick_imbalance_persistence_bias: Strategy = {
    name: "Wick Imbalance Persistence Bias",
    description: "Continues the defended side when the rolling median of wick imbalance holds a persistent bias.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const bias = buildRollingMedian(wickImbalance, lookback);

        return createSignalLoop(cleanData, [bias], (i) => {
            const level = bias[i];
            if (level === null) return null;

            if (level > BIAS_BAND) {
                return createBuySignal(cleanData, i, `Persistent defended lows: ${level.toFixed(2)}`);
            }
            if (level < -BIAS_BAND) {
                return createSellSignal(cleanData, i, `Persistent defended highs: ${level.toFixed(2)}`);
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
