import type { PairSelectionRule } from "./types";

export const directional_mean_reversion_zscore: PairSelectionRule = {
    key: "directional_mean_reversion_zscore",
    name: "Directional Mean Reversion Z-Score",
    description: "Ranks adverse 48-bar spread z-score displacement for a directional bounce.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_zscore_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/directional_mean_reversion_zscore.ts"],
    },
    score: (candidate) => {
        const zscore = candidate.feat_fp_spread_zscore_b48_r1;
        if (zscore === null) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? -zscore : zscore;
    },
};
