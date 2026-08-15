import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getWeightedClosePrices,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

const WEIGHTED_Z_BAND = 2.0;

function normalizeWeightedCloseZReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const weighted_close_z_reversion: Strategy = {
    name: "Weighted Close Z Reversion",
    description: "Fades z-score extremes of the weighted close (H + L + 2C) / 4, emphasizing settlement over intrabar noise.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeWeightedCloseZReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeWeightedCloseZReversionParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const weightedClose = getWeightedClosePrices(cleanData);
        const z = buildRollingZScore(weightedClose, lookback);

        return createSignalLoop(cleanData, [z], (i) => {
            if (i < lookback) return null;
            const zScore = z[i];
            if (zScore === null) return null;

            if (zScore < -WEIGHTED_Z_BAND) {
                return createBuySignal(cleanData, i, `Weighted close reversion buy: weighted z ${zScore.toFixed(2)}`);
            }
            if (zScore > WEIGHTED_Z_BAND) {
                return createSellSignal(cleanData, i, `Weighted close reversion sell: weighted z ${zScore.toFixed(2)}`);
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
