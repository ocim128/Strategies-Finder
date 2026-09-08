import type { PairSelectionRule } from "./types";

export const intraday_expansion_spread_premium: PairSelectionRule = {
    key: "intraday_expansion_spread_premium",
    name: "Intraday Expansion Spread Premium",
    description: "Ranks signal ATR percentage minus preceding 20-bar spread volatility.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/intraday_expansion_spread_premium.ts"],
    },
    score: (candidate) => {
        const atr = candidate.feat_atrPct;
        const vol = candidate.feat_pairSpreadVolatility20;
        if (atr === null || vol === null) return Number.NEGATIVE_INFINITY;
        return atr - vol;
    },
};
