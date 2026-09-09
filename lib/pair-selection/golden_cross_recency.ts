import type { PairSelectionRule } from "./types";

export const golden_cross_recency: PairSelectionRule = {
    key: "golden_cross_recency",
    name: "Golden Cross Recency",
    description: "Prefers candidates whose favorable fast-over-slow spread cross happened most recently.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/golden_cross_recency.ts"],
    },
    score: (candidate) => {
        const age = candidate.feat_fp_spread_golden_cross_age_r1;
        return age === null || !Number.isFinite(age) ? Number.NEGATIVE_INFINITY : -age;
    },
};
