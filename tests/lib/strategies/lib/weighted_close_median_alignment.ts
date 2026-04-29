import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getWeightedClosePrices } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeWeightedCloseMedianAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 63))),
    };
}

export const weighted_close_median_alignment: Strategy = {
    name: "Weighted Close Median Alignment",
    description:
        "Uses the rolling median of weighted close prices as a participation-aware centerline and aligns entries by whether the daily close is holding above or below it.",
    defaultParams: {
        lookback: 63,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeWeightedCloseMedianAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeWeightedCloseMedianAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const weightedClosePrices = getWeightedClosePrices(cleanData);
        const median = buildRollingMedian(weightedClosePrices, lookback);

        return createSignalLoop(cleanData, [median], (i) => {
            const m = median[i];
            if (m === null) return null;

            if (closes[i] > m) {
                return createBuySignal(cleanData, i, `Close above weighted-close median ${m.toFixed(2)}`);
            }
            if (closes[i] < m) {
                return createSellSignal(cleanData, i, `Close below weighted-close median ${m.toFixed(2)}`);
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
