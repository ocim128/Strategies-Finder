import type { PairSelectionRule } from "./types";

export const directional_drift_acceleration: PairSelectionRule = {
    key: "directional_drift_acceleration",
    name: "Directional Drift Acceleration",
    description: "Ranks direction-aligned fast-minus-baseline spread drift.",
    defaultParams: { baselineDriftWeight: 1.0 },
    paramLabels: { baselineDriftWeight: "Weight on 48-bar drift subtracted from 12-bar drift" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b12_r2",
                "feat_fp_spread_ols_slope_b48_r2",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_drift_acceleration.ts"],
    },
    score: (candidate, _event, params) => {
        const slope12 = candidate.feat_fp_spread_ols_slope_b12_r2;
        const slope48 = candidate.feat_fp_spread_ols_slope_b48_r2;
        if (slope12 === null || slope48 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * (slope12 - params.baselineDriftWeight! * slope48);
    },
};
