import type { PairSelectionRule } from "./types";

export const empirical_trade_payoff_skewness: PairSelectionRule = {
    key: "empirical_trade_payoff_skewness",
    name: "Empirical Trade Payoff Skewness",
    description: "Ranks the empirical average-win to average-loss payoff ratio.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: ["feat_fp_trade_profit_factor_t8_r1", "feat_fp_trade_win_fraction_t8_r1"],
        },
        sourceFiles: ["lib/pair-selection/empirical_trade_payoff_skewness.ts"],
    },
    score: (candidate) => {
        const pf = candidate.feat_fp_trade_profit_factor_t8_r1;
        const p = candidate.feat_fp_trade_win_fraction_t8_r1;
        if (pf === null || p === null || p <= 0 || p > 1) return Number.NEGATIVE_INFINITY;
        return pf * ((1 - p) / p);
    },
};
