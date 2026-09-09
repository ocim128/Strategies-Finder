import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const pre_event_vol_scaled_momentum: PairSelectionRule = {
    key: "pre_event_vol_scaled_momentum",
    name: "Pre Event Vol Scaled Momentum",
    description: "Divides directional 48-bar spread momentum by the pair's prior 20-bar spread volatility.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/pre_event_vol_scaled_momentum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const volatility = candidate.feat_pairSpreadVolatility20;
        if (return48 === null || volatility === null || !Number.isFinite(volatility) || volatility <= 0) {
            return Number.NEGATIVE_INFINITY;
        }
        return return48 / volatility;
    },
};
