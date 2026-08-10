import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeSlowAnchorRatioReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        anchorLookback: Math.max(50, Math.round(Number(params.anchorLookback ?? 200))),
    };
}

export const slow_anchor_ratio_reversion: Strategy = {
    name: "Slow Anchor Ratio Reversion",
    description: "Fades extreme close percentiles against a very long equilibrium anchor window.",
    defaultParams: {
        anchorLookback: 200,
    },
    paramLabels: {
        anchorLookback: "Anchor Lookback",
    },
    normalizeParams: normalizeSlowAnchorRatioReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSlowAnchorRatioReversionParams(params);
        const anchorLookback = p.anchorLookback as number;
        if (cleanData.length < anchorLookback + 1) return [];

        const closes = getCloses(cleanData);
        const closePct = buildPercentileRank(closes, anchorLookback);

        return createSignalLoop(cleanData, [closePct], (i) => {
            if (i < anchorLookback) return null;
            const rank = closePct[i];
            if (rank === null) return null;

            if (rank < 0.1) {
                return createBuySignal(cleanData, i, `Close percentile ${rank.toFixed(2)} at the bottom of the ${anchorLookback}-bar anchor`);
            }
            if (rank > 0.9) {
                return createSellSignal(cleanData, i, `Close percentile ${rank.toFixed(2)} at the top of the ${anchorLookback}-bar anchor`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["anchorLookback"],
    },
};
