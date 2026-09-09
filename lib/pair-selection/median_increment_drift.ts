import type { PairSelectionRule } from "./types";

export const median_increment_drift: PairSelectionRule = {
    key: "median_increment_drift",
    name: "Median Increment Drift",
    description: "Ranks the median direction-adjusted spread increment over the 48-bar path.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/median_increment_drift.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_median_increment_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
