import type { PairSelectionRule } from "./types";

export const trade_expectancy_to_win_rate_ratio: PairSelectionRule = {
    key: "trade_expectancy_to_win_rate_ratio",
    name: "Trade Expectancy to Win Rate Ratio",
    description: "Ranks rolling mean net return per unit of rolling win fraction.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_trade_mean_net_pct_t8_r1",
                "feat_fp_trade_win_fraction_t8_r1",
                "feat_fp_trade_win_fraction_t8_r1_n",
            ],
        },
        sourceFiles: ["lib/pair-selection/trade_expectancy_to_win_rate_ratio.ts"],
    },
    score: (candidate) => {
        const mean = candidate.feat_fp_trade_mean_net_pct_t8_r1;
        const wr = candidate.feat_fp_trade_win_fraction_t8_r1;
        const n = candidate.feat_fp_trade_win_fraction_t8_r1_n;
        if (mean === null || wr === null || n === null || n < 4 || wr <= 0) return Number.NEGATIVE_INFINITY;
        return mean / wr;
    },
};
