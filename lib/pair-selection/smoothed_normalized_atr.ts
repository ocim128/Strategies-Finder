import type { PairSelectionRule } from "./types";

export const smoothed_normalized_atr: PairSelectionRule = {
    key: "smoothed_normalized_atr",
    name: "Smoothed Normalized ATR",
    description: "Ranks valid 12-bar smoothed normalized ATR.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_volatility_normalized_atr_b12_r1"] },
        sourceFiles: ["lib/pair-selection/smoothed_normalized_atr.ts"],
    },
    score: (candidate) => {
        const natr = candidate.feat_fp_volatility_normalized_atr_b12_r1;
        if (natr === null || !Number.isFinite(natr) || natr <= 0) return Number.NEGATIVE_INFINITY;
        return natr;
    },
};
