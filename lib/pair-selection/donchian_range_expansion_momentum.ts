import type { PairSelectionRule } from "./types";

export const donchian_range_expansion_momentum: PairSelectionRule = {
    key: "donchian_range_expansion_momentum",
    name: "Donchian Range Expansion Momentum",
    description: "Scales direction-aligned 48-bar return by 12-bar versus 48-bar range expansion.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_distance_above_min_b12_r1",
                "feat_fp_spread_distance_below_max_b12_r1",
                "feat_fp_spread_distance_above_min_b48_r1",
                "feat_fp_spread_distance_below_max_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/donchian_range_expansion_momentum.ts"],
    },
    score: (candidate) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const distMin12 = candidate.feat_fp_spread_distance_above_min_b12_r1;
        const distMax12 = candidate.feat_fp_spread_distance_below_max_b12_r1;
        const distMin48 = candidate.feat_fp_spread_distance_above_min_b48_r1;
        const distMax48 = candidate.feat_fp_spread_distance_below_max_b48_r1;
        if (ret48 === null || distMin12 === null || distMax12 === null || distMin48 === null || distMax48 === null) {
            return Number.NEGATIVE_INFINITY;
        }
        const denominator = distMin48 + distMax48;
        if (denominator <= 0) return Number.NEGATIVE_INFINITY;
        const directionalRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return directionalRet48 * ((distMin12 + distMax12) / denominator);
    },
};
