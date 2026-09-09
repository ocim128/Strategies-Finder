import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const record_print_rate_momentum: PairSelectionRule = {
    key: "record_print_rate_momentum",
    name: "Record Print Rate Momentum",
    description: "Weights directional 48-bar spread drift by the frequency of new running-high prints.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/record_print_rate_momentum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const recordRate = candidate.feat_fp_spread_record_print_rate_b48_r1;
        if (return48 === null || recordRate === null || !Number.isFinite(recordRate)) {
            return Number.NEGATIVE_INFINITY;
        }
        return return48 * recordRate;
    },
};
