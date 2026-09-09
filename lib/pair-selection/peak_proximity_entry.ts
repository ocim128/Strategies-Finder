import type { PairSelectionRule } from "./types";

export const peak_proximity_entry: PairSelectionRule = {
    key: "peak_proximity_entry",
    name: "Peak Proximity Entry",
    description: "Prefers candidates whose final direction-adjusted spread level is nearest its 48-bar running peak.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_peak_distance_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/peak_proximity_entry.ts"],
    },
    score: (candidate) => {
        const distance = candidate.feat_fp_spread_peak_distance_b48_r1;
        return distance === null || !Number.isFinite(distance)
            ? Number.NEGATIVE_INFINITY
            : -distance;
    },
};
