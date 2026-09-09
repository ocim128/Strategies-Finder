import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const jump_discounted_drift: PairSelectionRule = {
    key: "jump_discounted_drift",
    name: "Jump Discounted Drift",
    description: "Discounts directional 48-bar spread drift by the path's jump concentration.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_tail_concentration_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/jump_discounted_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const concentration = candidate.feat_fp_spread_tail_concentration_b48_r1;
        if (return48 === null || concentration === null) return Number.NEGATIVE_INFINITY;
        return return48 * (1 - concentration);
    },
};
