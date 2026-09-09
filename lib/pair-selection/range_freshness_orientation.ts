import type { PairSelectionRule } from "./types";

export const range_freshness_orientation: PairSelectionRule = {
    key: "range_freshness_orientation",
    name: "Range Freshness Orientation",
    description: "Prefers direction-adjusted paths whose running high is fresher than their running low.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/range_freshness_orientation.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_extreme_age_gap_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
