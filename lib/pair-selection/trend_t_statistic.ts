import type { PairSelectionRule } from "./types";

export const trend_t_statistic: PairSelectionRule = {
    key: "trend_t_statistic",
    name: "Trend T Statistic",
    description: "Ranks the signed t-statistic of the direction-adjusted 48-bar spread trend.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/trend_t_statistic.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_trend_t_stat_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
