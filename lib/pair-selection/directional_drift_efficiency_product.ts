import type { PairSelectionRule } from "./types";

export const directional_drift_efficiency_product: PairSelectionRule = {
    key: "directional_drift_efficiency_product",
    name: "Directional Drift Efficiency Product",
    description: "Multiplies direction-aligned 48-bar OLS slope by Kaufman efficiency.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_drift_efficiency_product.ts"],
    },
    score: (candidate) => {
        const slope = candidate.feat_fp_spread_ols_slope_b48_r2;
        const eff = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (slope === null || eff === null) return Number.NEGATIVE_INFINITY;
        const dirSlope = candidate.direction === "long" ? slope : -slope;
        return dirSlope * eff;
    },
};
