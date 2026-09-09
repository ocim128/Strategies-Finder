import type { PairSelectionRule } from "./types";

export const leg_correlation_independence: PairSelectionRule = {
    key: "leg_correlation_independence",
    name: "Leg Correlation Independence",
    description: "Prefers lower recent Pearson correlation between the pair's base and quote leg returns.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/leg_correlation_independence.ts"],
    },
    score: (candidate) => {
        const correlation = candidate.feat_fp_leg_return_correlation_b48_r1;
        return correlation === null || !Number.isFinite(correlation)
            ? Number.NEGATIVE_INFINITY
            : -correlation;
    },
};
