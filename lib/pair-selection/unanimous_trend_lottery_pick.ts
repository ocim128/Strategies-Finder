import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const unanimous_trend_lottery_pick: PairSelectionRule = {
    key: "unanimous_trend_lottery_pick",
    name: "Unanimous Trend Lottery Pick",
    description: "Uses the shared FNV tie-break to pick among candidates positive at all three directional horizons.",
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
            "lib/pair-selection/unanimous_trend_lottery_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return12 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b12_r1);
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const return240 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b240_r1);
        return return12 !== null && return48 !== null && return240 !== null
            && return12 > 0 && return48 > 0 && return240 > 0
            ? 1
            : 0;
    },
};
