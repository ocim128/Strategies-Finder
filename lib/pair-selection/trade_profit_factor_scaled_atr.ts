import type { PairSelectionRule } from "./types";

export const trade_profit_factor_scaled_atr: PairSelectionRule = {
    key: "trade_profit_factor_scaled_atr",
    name: "Trade Profit Factor Scaled ATR",
    description: "Ranks rolling trade profit factor scaled by signal ATR percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_trade_profit_factor_t8_r1"],
        },
        sourceFiles: ["lib/pair-selection/trade_profit_factor_scaled_atr.ts"],
    },
    score: (candidate) => {
        const pf = candidate.feat_fp_trade_profit_factor_t8_r1;
        const atr = candidate.feat_atrPct;
        if (pf === null || atr === null || pf <= 0 || atr <= 0) return Number.NEGATIVE_INFINITY;
        return pf * atr;
    },
};
