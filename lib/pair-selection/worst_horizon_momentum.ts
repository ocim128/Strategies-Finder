import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const worst_horizon_momentum: PairSelectionRule = {
    key: "worst_horizon_momentum",
    name: "Worst Horizon Momentum",
    description: "Ranks candidates by the weakest of their direction-adjusted 12-, 48-, and 240-bar returns.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_log_return_b240_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/worst_horizon_momentum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return12 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b12_r1);
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const return240 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b240_r1);
        if (return12 === null || return48 === null || return240 === null) return Number.NEGATIVE_INFINITY;
        return Math.min(return12, return48, return240);
    },
};
