import type { PairSelectionRule } from "./types";

export const volatility_weighted_20bar_momentum: PairSelectionRule = {
    key: "volatility_weighted_20bar_momentum",
    name: "Volatility Weighted 20-Bar Momentum",
    description: "Multiplies direction-aligned 20-bar return by signal ATR percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/volatility_weighted_20bar_momentum.ts"],
    },
    score: (candidate) => {
        const ret = candidate.feat_return20;
        const atr = candidate.feat_atrPct;
        if (ret === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        const dirRet = candidate.direction === "long" ? ret : -ret;
        return dirRet * atr;
    },
};
