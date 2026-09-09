import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const autocorr_penalized_drift: PairSelectionRule = {
    key: "autocorr_penalized_drift",
    name: "Autocorrelation Penalized Drift",
    description: "Penalizes directional 48-bar spread drift by the absolute lag-1 return autocorrelation.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_dependence_return_acf_b48_l1_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/autocorr_penalized_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const autocorrelation = candidate.feat_fp_dependence_return_acf_b48_l1_r1;
        if (return48 === null || autocorrelation === null || !Number.isFinite(autocorrelation)) {
            return Number.NEGATIVE_INFINITY;
        }
        return return48 * (1 - Math.abs(autocorrelation));
    },
};
