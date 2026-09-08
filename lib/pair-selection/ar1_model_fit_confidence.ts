import type { PairSelectionRule } from "./types";

export const ar1_model_fit_confidence: PairSelectionRule = {
    key: "ar1_model_fit_confidence",
    name: "AR1 Model Fit Confidence",
    description: "Ranks the 48-bar AR(1) coefficient of determination.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_dependence_ar1_r_squared_b48_r1"] },
        sourceFiles: ["lib/pair-selection/ar1_model_fit_confidence.ts"],
    },
    score: (candidate) => {
        const r2 = candidate.feat_fp_dependence_ar1_r_squared_b48_r1;
        if (r2 === null || !Number.isFinite(r2) || r2 < 0) return Number.NEGATIVE_INFINITY;
        return r2;
    },
};
