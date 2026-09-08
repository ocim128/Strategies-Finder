import type { PairSelectionRule } from "./types";

export const atr_normalized_spread_dislocation: PairSelectionRule = {
    key: "atr_normalized_spread_dislocation",
    name: "ATR Normalized Spread Dislocation",
    description: "Ranks direction-aligned 48-bar distance to the spread median in ATR units.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_spread_distance_to_median_b48_r1"] },
        sourceFiles: ["lib/pair-selection/atr_normalized_spread_dislocation.ts"],
    },
    score: (candidate) => {
        const dist = candidate.feat_fp_spread_distance_to_median_b48_r1;
        const atr = candidate.feat_atrPct;
        if (dist === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return (candidate.direction === "long" ? dist : -dist) / atr;
    },
};
