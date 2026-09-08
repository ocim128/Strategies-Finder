import type { PairSelectionRule } from "./types";

export const trade_longevity_experience: PairSelectionRule = {
    key: "trade_longevity_experience",
    name: "Trade Longevity Experience",
    description: "Ranks pairs by finite historical closed-trade count.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/trade_longevity_experience.ts"],
    },
    score: (candidate) => {
        const trades = candidate.feat_pairTradesPrior;
        if (trades === null || !Number.isFinite(trades) || trades <= 0) return Number.NEGATIVE_INFINITY;
        return trades;
    },
};
