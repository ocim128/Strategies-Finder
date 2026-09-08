import type { PairSelectionRule } from "./types";

export const directional_spread_zscore_extremity: PairSelectionRule = {
    key: "directional_spread_zscore_extremity",
    name: "Directional Spread Z-Score Extremity",
    description: "Ranks direction-aligned 48-bar spread z-score extremity.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_zscore_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/directional_spread_zscore_extremity.ts"],
    },
    score: (candidate) => {
        const zscore = candidate.feat_fp_spread_zscore_b48_r1;
        if (zscore === null) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? zscore : -zscore;
    },
};
