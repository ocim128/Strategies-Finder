import type { PairSelectionRule } from "./types";

export const variance_ratio_mean_reversion_elasticity: PairSelectionRule = {
    key: "variance_ratio_mean_reversion_elasticity",
    name: "Variance Ratio Mean Reversion Elasticity",
    description: "Scales adverse z-score displacement by sub-unity variance-ratio mean-reversion intensity.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_zscore_b48_r1",
                "feat_fp_dependence_variance_ratio_b48_h4_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/variance_ratio_mean_reversion_elasticity.ts"],
    },
    score: (candidate) => {
        const zscore = candidate.feat_fp_spread_zscore_b48_r1;
        const varianceRatio = candidate.feat_fp_dependence_variance_ratio_b48_h4_r1;
        if (zscore === null || varianceRatio === null) return Number.NEGATIVE_INFINITY;
        const adverseZscore = candidate.direction === "long" ? -zscore : zscore;
        return adverseZscore * Math.max(0, 1.0 - varianceRatio);
    },
};
