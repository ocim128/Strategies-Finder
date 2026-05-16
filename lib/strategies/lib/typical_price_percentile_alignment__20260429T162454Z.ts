import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeTypicalPricePercentileAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
        threshold: Math.max(50, Math.min(99, Number(params.threshold ?? 65))),
    };
}

export const typical_price_percentile_alignment: Strategy = {
    name: "Typical Price Percentile Alignment",
    description:
        "Measures where the current typical price sits inside its own trailing distribution and aligns entries only when that state is already meaningfully high or low.",
    defaultParams: {
        lookback: 63,
        threshold: 65,
    },
    paramLabels: {
        lookback: "Lookback",
        threshold: "Threshold",
    },
    normalizeParams: normalizeTypicalPricePercentileAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPricePercentileAlignmentParams(params);
        const lookback = p.lookback as number;
        const threshold = (p.threshold as number) / 100;
        if (cleanData.length < lookback + 1) return [];

        const typicalPrices = getTypicalPrices(cleanData);
        const rank = buildPercentileRank(typicalPrices, lookback);

        return createSignalLoop(cleanData, [rank], (i) => {
            const percentileRank = rank[i];
            if (percentileRank === null) return null;

            if (percentileRank > threshold) {
                return createBuySignal(cleanData, i, `Typical price percentile ${(percentileRank * 100).toFixed(1)}% above threshold`);
            }
            if (percentileRank < 1 - threshold) {
                return createSellSignal(cleanData, i, `Typical price percentile ${(percentileRank * 100).toFixed(1)}% below inverse threshold`);
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





