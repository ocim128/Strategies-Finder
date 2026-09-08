import type { PairSelectionRule } from "./types";

export const efficient_loud_drift_product: PairSelectionRule = {
    key: "efficient_loud_drift_product",
    name: "Efficient Loud Drift Product",
    description: "Multiplies direction-aligned 48-bar drift by efficiency and signal ATR.",
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
        sourceFiles: ["lib/pair-selection/efficient_loud_drift_product.ts"],
    },
    score: (candidate) => {
        const slope48 = candidate.feat_fp_spread_ols_slope_b48_r2;
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        const atr = candidate.feat_atrPct;
        if (slope48 === null || efficiency === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        const directionalSlope48 = candidate.direction === "long" ? slope48 : -slope48;
        return directionalSlope48 * efficiency * atr;
    },
};
