import type { PairSelectionRule } from "./types";

export const adverse_channel_bounce_proximity: PairSelectionRule = {
    key: "adverse_channel_bounce_proximity",
    name: "Adverse Channel Bounce Proximity",
    description: "Prefers directionally adverse 48-bar channel extremes closest to the boundary.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_distance_above_min_b48_r1",
                "feat_fp_spread_distance_below_max_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/adverse_channel_bounce_proximity.ts"],
    },
    score: (candidate) => {
        const distance = candidate.direction === "long"
            ? candidate.feat_fp_spread_distance_above_min_b48_r1
            : candidate.feat_fp_spread_distance_below_max_b48_r1;
        if (distance === null) return Number.NEGATIVE_INFINITY;
        return -distance;
    },
};
