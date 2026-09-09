import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const skew_weighted_drift: PairSelectionRule = {
    key: "skew_weighted_drift",
    name: "Skew Weighted Drift",
    description: "Weights directional 48-bar spread drift by the skewness of its direction-adjusted increments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/skew_weighted_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const skew = candidate.feat_fp_spread_increment_skew_b48_r1;
        if (return48 === null || skew === null || !Number.isFinite(skew)) return Number.NEGATIVE_INFINITY;
        return return48 * skew;
    },
};
