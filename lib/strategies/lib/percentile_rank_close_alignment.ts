import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizePercentileRankCloseAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(params.lookback ?? 20)),
        threshold: Math.min(0.99, Math.max(0.01, Number(params.threshold ?? 0.7))),
    };
}

export const percentile_rank_close_alignment: Strategy = {
    name: "Percentile Rank Close Alignment",
    description: "The percentile rank of the current close within its trailing distribution directly measures positional extremity. High percentile means price sits in the upper tail of recent closes, indicating bullish distribution alignment; low percentile indicates bearish alignment.",
    defaultParams: {
        lookback: 20,
        threshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizePercentileRankCloseAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePercentileRankCloseAlignmentParams(params);
        if (cleanData.length < p.lookback) return [];

        const closes = getCloses(cleanData);
        const percentileRank = buildPercentileRank(closes, p.lookback);

        return createSignalLoop(cleanData, [percentileRank], (i) => {
            if (i < p.lookback) return null;
            const rank = percentileRank[i];
            if (rank === null) return null;

            if (rank > p.threshold) {
                return createBuySignal(cleanData, i, `Percentile rank ${rank.toFixed(3)} above threshold`);
            }
            if (rank < (1 - p.threshold)) {
                return createSellSignal(cleanData, i, `Percentile rank ${rank.toFixed(3)} below inverse threshold`);
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
