import type { PairSelectionRule } from "./types";

export const linear_determination_scaled_drift: PairSelectionRule = {
    key: "linear_determination_scaled_drift",
    name: "Linear Determination Scaled Drift",
    description: "Scales direction-aligned 48-bar OLS drift by AR(1) R-squared.",
    defaultParams: { determinationExponent: 1.0 },
    paramLabels: { determinationExponent: "Exponent applied to 48-bar AR(1) R-squared" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_dependence_ar1_r_squared_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/linear_determination_scaled_drift.ts"],
    },
    score: (candidate, _event, params) => {
        const slope48 = candidate.feat_fp_spread_ols_slope_b48_r2;
        const rSquared = candidate.feat_fp_dependence_ar1_r_squared_b48_r1;
        if (slope48 === null || rSquared === null) return Number.NEGATIVE_INFINITY;
        const dirSlope48 = candidate.direction === "long" ? slope48 : -slope48;
        return dirSlope48 * Math.pow(Math.max(0, rSquared), params.determinationExponent!);
    },
};
