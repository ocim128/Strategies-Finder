import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeNaiveRatioZScoreReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
    };
}

export const naive_ratio_zscore_reversion: Strategy = {
    name: "Naive Ratio Z-Score Reversion",
    description: "Rolling center reversion on extreme stretch.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeNaiveRatioZScoreReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeNaiveRatioZScoreReversionParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.zThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [zscore], (i) => {
            const z = zscore[i];
            if (z === null) return null;

            if (z < -zThreshold) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Z-score stretched down at ${z.toFixed(2)}`
                );
            }
            if (z > zThreshold) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Z-score stretched up at ${z.toFixed(2)}`
                );
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
