import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const horizon_conflict_lottery_pick: PairSelectionRule = {
    key: "horizon_conflict_lottery_pick",
    name: "Horizon Conflict Lottery Pick",
    description: "Uses the shared deterministic tie-break inside the tier whose 12-bar and 240-bar directional returns disagree.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b240_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/horizon_conflict_lottery_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return12 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b12_r1);
        const return240 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b240_r1);
        return return12 !== null && return240 !== null
            && ((return12 < 0 && return240 > 0) || (return12 > 0 && return240 < 0))
            ? 1
            : 0;
    },
};
