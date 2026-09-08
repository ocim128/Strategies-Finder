import type { PairSelectionRule } from "./types";

export const breakout_high_water_proximity: PairSelectionRule = {
    key: "breakout_high_water_proximity",
    name: "Breakout High Water Proximity",
    description: "Prefers directional spread closes nearest the preceding 48-bar extreme.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_spread_distance_below_max_b48_r1",
                "feat_fp_spread_distance_above_min_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/breakout_high_water_proximity.ts"],
    },
    score: (candidate) => {
        const dist = candidate.direction === "long"
            ? candidate.feat_fp_spread_distance_below_max_b48_r1
            : candidate.feat_fp_spread_distance_above_min_b48_r1;
        if (dist === null || dist < 0) return Number.NEGATIVE_INFINITY;
        return -dist;
    },
};
