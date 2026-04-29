import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeDistributionRankStateAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 126))),
        threshold: Math.max(0.5, Math.min(0.99, Number(params.threshold ?? 0.8))),
    };
}

export const distribution_rank_state_alignment: Strategy = {
    name: "Distribution Rank State Alignment",
    description:
        "Treats the trailing close distribution as a state map and aligns entries once price is persistently living in the upper or lower tail of that range.",
    defaultParams: {
        lookback: 126,
        threshold: 0.8,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizeDistributionRankStateAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDistributionRankStateAlignmentParams(params);
        const lookback = p.lookback as number;
        const threshold = p.threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const rank = buildPercentileRank(closes, lookback);

        return createSignalLoop(cleanData, [rank], (i) => {
            const percentileRank = rank[i];
            if (percentileRank === null) return null;

            if (percentileRank > threshold) {
                return createBuySignal(cleanData, i, `Close rank ${percentileRank.toFixed(2)} above regime threshold`);
            }
            if (percentileRank < 1 - threshold) {
                return createSellSignal(cleanData, i, `Close rank ${percentileRank.toFixed(2)} below inverse threshold`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "threshold"],
    },
};
