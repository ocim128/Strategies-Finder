import type { PairSelectionRule } from "./types";

export const concordant_drift_velocity_product: PairSelectionRule = {
    key: "concordant_drift_velocity_product",
    name: "Concordant Drift Velocity Product",
    description: "Ranks 48-bar directional drift gated by the short-term directional slope.",
    defaultParams: { minShortSlopeGate: 0.0 },
    paramLabels: { minShortSlopeGate: "Floor applied to 12-bar direction-aligned slope" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b12_r2",
                "feat_fp_spread_ols_slope_b48_r2",
            ],
        },
        sourceFiles: ["lib/pair-selection/concordant_drift_velocity_product.ts"],
    },
    score: (candidate, _event, params) => {
        const slope12 = candidate.feat_fp_spread_ols_slope_b12_r2;
        const slope48 = candidate.feat_fp_spread_ols_slope_b48_r2;
        if (slope12 === null || slope48 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        const dirSlope12 = sign * slope12;
        const dirSlope48 = sign * slope48;
        return dirSlope48 * Math.max(params.minShortSlopeGate!, dirSlope12);
    },
};
