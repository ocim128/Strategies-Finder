import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const leverage_healing_weight: PairSelectionRule = {
    key: "leverage_healing_weight",
    name: "Leverage Healing Weight",
    description: "Weights directional 48-bar spread drift by the negative leverage-response statistic of its increments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_leverage_stat_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/leverage_healing_weight.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const leverage = candidate.feat_fp_spread_leverage_stat_b48_r1;
        if (return48 === null || leverage === null || !Number.isFinite(leverage)) return Number.NEGATIVE_INFINITY;
        return return48 * -leverage;
    },
};
