import type { PairSelectionRule } from "./types";

export const directional_spread_zscore_momentum: PairSelectionRule = {
    key: "directional_spread_zscore_momentum",
    name: "Directional Spread Z-Score Momentum",
    description: "Ranks the 48-bar spread z-score after aligning it with signal direction.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_spread_zscore_b48_r1"] },
        sourceFiles: ["lib/pair-selection/directional_spread_zscore_momentum.ts"],
    },
    score: (candidate) => {
        const z = candidate.feat_fp_spread_zscore_b48_r1;
        if (z === null || !Number.isFinite(z)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? z : -z;
    },
};
