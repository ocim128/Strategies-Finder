import type { PairSelectionRule } from "./types";

export const directional_stochastic_range_position: PairSelectionRule = {
    key: "directional_stochastic_range_position",
    name: "Directional Stochastic Range Position",
    description: "Ranks direction-aligned position within the preceding 240-bar spread range.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_spread_distance_above_min_b240_r1",
                "feat_fp_spread_distance_below_max_b240_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_stochastic_range_position.ts"],
    },
    score: (candidate) => {
        const minD = candidate.feat_fp_spread_distance_above_min_b240_r1;
        const maxD = candidate.feat_fp_spread_distance_below_max_b240_r1;
        if (minD === null || maxD === null || minD + maxD <= 0) return Number.NEGATIVE_INFINITY;
        const k = minD / (minD + maxD);
        return candidate.direction === "long" ? k : 1 - k;
    },
};
