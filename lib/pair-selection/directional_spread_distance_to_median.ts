import type { PairSelectionRule } from "./types";

export const directional_spread_distance_to_median: PairSelectionRule = {
    key: "directional_spread_distance_to_median",
    name: "Directional Spread Distance to Median",
    description: "Ranks direction-aligned distance from the 48-bar spread median.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_distance_to_median_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/directional_spread_distance_to_median.ts"],
    },
    score: (candidate) => {
        const distance = candidate.feat_fp_spread_distance_to_median_b48_r1;
        if (distance === null) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? distance : -distance;
    },
};
