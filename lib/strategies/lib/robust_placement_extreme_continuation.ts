import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const EXTREME_Z = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const robust_placement_extreme_continuation: Strategy = {
    name: "Robust Placement Extreme Continuation",
    description: "Continues when close location is robustly extreme relative to its own trailing median and MAD.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Robust Z Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const location = buildCloseLocationSeries(cleanData);
        const z = buildRollingRobustZScore(location, lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            const score = z[i];
            if (score === null) return null;

            if (score >= EXTREME_Z && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Robust high placement: z ${score.toFixed(2)}`);
            }
            if (score <= -EXTREME_Z && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Robust low placement: z ${score.toFixed(2)}`);
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
