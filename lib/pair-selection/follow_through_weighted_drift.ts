import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const follow_through_weighted_drift: PairSelectionRule = {
    key: "follow_through_weighted_drift",
    name: "Follow Through Weighted Drift",
    description: "Weights directional 48-bar spread drift by the same-sign transition rate of its increments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/follow_through_weighted_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const followThrough = candidate.feat_fp_spread_follow_through_rate_b48_r1;
        if (return48 === null || followThrough === null || !Number.isFinite(followThrough)) {
            return Number.NEGATIVE_INFINITY;
        }
        return return48 * followThrough;
    },
};
