import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeCloseDistributionPercentileParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 50)),
    };
}

export const close_distribution_percentile: Strategy = {
    name: "Close Distribution Percentile",
    description: "The percentile rank of the current close inside its trailing close distribution measures where price resides within recent history. High ranks indicate upper-tail occupancy; low ranks indicate lower-tail occupancy.",
    defaultParams: {
        lookback: 50,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeCloseDistributionPercentileParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCloseDistributionPercentileParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const percentile = buildPercentileRank(closes, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const rank = percentile[i];
            if (rank === null) return null;

            if (rank > 0.5) {
                return createBuySignal(cleanData, i, `Close percentile ${(rank * 100).toFixed(1)}% above median state`);
            }
            if (rank < 0.5) {
                return createSellSignal(cleanData, i, `Close percentile ${(rank * 100).toFixed(1)}% below median state`);
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
