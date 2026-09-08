import type { PairSelectionRule } from "./types";

export const autoregressive_persistence_scaled_drift: PairSelectionRule = {
    key: "autoregressive_persistence_scaled_drift",
    name: "Autoregressive Persistence Scaled Drift",
    description: "Scales direction-aligned 48-bar OLS drift by nonnegative AR(1) persistence.",
    defaultParams: { persistenceExponent: 1.0 },
    paramLabels: { persistenceExponent: "Exponent applied to AR(1) slope persistence" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_dependence_ar1_slope_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/autoregressive_persistence_scaled_drift.ts"],
    },
    score: (candidate, _event, params) => {
        const slope48 = candidate.feat_fp_spread_ols_slope_b48_r2;
        const ar1Slope = candidate.feat_fp_dependence_ar1_slope_b48_r1;
        if (slope48 === null || ar1Slope === null) return Number.NEGATIVE_INFINITY;
        const dirSlope48 = candidate.direction === "long" ? slope48 : -slope48;
        return dirSlope48 * Math.pow(Math.max(0, ar1Slope), params.persistenceExponent!);
    },
};
