import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zscoreThreshold: Math.max(0.01, Number(params.zscoreThreshold ?? 2.0)),
    };
}

export const return_zscore_extreme_reversion: Strategy = {
    name: "Return Z-Score Extreme Reversion",
    description: "Fades return z-score extremes as statistical outliers on mean-reverting ratios.",
    defaultParams: {
        lookback: 30,
        zscoreThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zscoreThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const zscore = buildRollingZScore(returns, lookback);

        return createSignalLoop(cleanData, [zscore], (i) => {
            const z = zscore[i];
            if (z === null) return null;

            // Buy: return z-score is extremely negative
            if (z < -p.zscoreThreshold) {
                return createBuySignal(cleanData, i, `Return Z-score extreme buy: Z-score ${z.toFixed(2)}`);
            }
            // Sell: return z-score is extremely positive
            if (z > p.zscoreThreshold) {
                return createSellSignal(cleanData, i, `Return Z-score extreme sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zscoreThreshold"],
    },
};
