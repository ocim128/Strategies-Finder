import type { PairSelectionRule } from "./types";

export const pullback_discounted_directional_momentum: PairSelectionRule = {
    key: "pullback_discounted_directional_momentum",
    name: "Pullback Discounted Directional Momentum",
    description: "Discounts direction-aligned 48-bar return by distance from its favorable extremum.",
    defaultParams: { pullbackDecayRate: 10.0 },
    paramLabels: { pullbackDecayRate: "Exponential penalty rate on distance from the favorable 48-bar extremum" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_distance_below_max_b48_r1",
                "feat_fp_spread_distance_above_min_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/pullback_discounted_directional_momentum.ts"],
    },
    score: (candidate, _event, params) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const distance = candidate.direction === "long"
            ? candidate.feat_fp_spread_distance_below_max_b48_r1
            : candidate.feat_fp_spread_distance_above_min_b48_r1;
        if (ret48 === null || distance === null) return Number.NEGATIVE_INFINITY;
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 * Math.exp(-params.pullbackDecayRate! * distance);
    },
};
