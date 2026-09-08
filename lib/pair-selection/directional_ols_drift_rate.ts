import type { PairSelectionRule } from "./types";

export const directional_ols_drift_rate: PairSelectionRule = {
    key: "directional_ols_drift_rate",
    name: "Directional OLS Drift Rate",
    description: "Ranks the 48-bar spread OLS slope after aligning it with signal direction.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_spread_ols_slope_b48_r2"] },
        sourceFiles: ["lib/pair-selection/directional_ols_drift_rate.ts"],
    },
    score: (candidate) => {
        const slope = candidate.feat_fp_spread_ols_slope_b48_r2;
        if (slope === null || !Number.isFinite(slope)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? slope : -slope;
    },
};
