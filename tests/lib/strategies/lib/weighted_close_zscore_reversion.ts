import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getWeightedClosePrices,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.1)),
    };
}

export const weighted_close_zscore_reversion: Strategy = {
    name: "Weighted Close Z-Score Reversion",
    description: "Fades extreme deviations of the weighted close price from its rolling center.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.1,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const wCloses = getWeightedClosePrices(cleanData);
        const zScore = buildRollingZScore(wCloses, lookback);

        return createSignalLoop(cleanData, [zScore], (i) => {
            const z = zScore[i];
            if (z === null) return null;

            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Weighted close buy: Z-score ${z.toFixed(2)}`);
            }
            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Weighted close sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
