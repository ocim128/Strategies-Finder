import { directionAdjusted, medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const breadth_sign_conditioned_drift: PairSelectionRule = {
    key: "breadth_sign_conditioned_drift",
    name: "Breadth Sign Conditioned Drift",
    description: "Ranks each candidate by its directional 48-bar drift, flipped to follow the event median sign.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/breadth_sign_conditioned_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const eventMedian = memoByPool(pool, "breadth-sign-conditioned-drift-median", () =>
            medianValid(pool, (entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1)));
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (eventMedian === null || return48 === null) return Number.NEGATIVE_INFINITY;
        return Math.sign(eventMedian) * return48;
    },
};
