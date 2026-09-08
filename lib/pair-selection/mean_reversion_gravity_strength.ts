import type { PairSelectionRule } from "./types";

export const mean_reversion_gravity_strength: PairSelectionRule = {
    key: "mean_reversion_gravity_strength",
    name: "Mean Reversion Gravity Strength",
    description: "Minimizes valid positive AR(1) persistence slope below one.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_dependence_ar1_slope_b48_r1"] },
        sourceFiles: ["lib/pair-selection/mean_reversion_gravity_strength.ts"],
    },
    score: (candidate) => {
        const phi = candidate.feat_fp_dependence_ar1_slope_b48_r1;
        if (phi === null || !Number.isFinite(phi) || phi <= 0 || phi >= 1) return Number.NEGATIVE_INFINITY;
        return -phi;
    },
};
