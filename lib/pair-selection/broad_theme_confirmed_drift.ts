import { directionAdjusted, getDirectional48BarCohortAlignments } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

function sign(value: number | null): -1 | 0 | 1 {
    if (value === null || value === 0) return 0;
    return value < 0 ? -1 : 1;
}

export const broad_theme_confirmed_drift: PairSelectionRule = {
    key: "broad_theme_confirmed_drift",
    name: "Broad Theme Confirmed Drift",
    description: "Weights directional spread drift by same-sign leave-one-out base and quote cohort environments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/broad_theme_confirmed_drift.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const alignment = getDirectional48BarCohortAlignments(pool).get(candidate);
        if (!alignment) return Number.NEGATIVE_INFINITY;
        const weight = sign(alignment.base) * sign(alignment.quote);
        return weight === 0 ? Number.NEGATIVE_INFINITY : return48 * weight;
    },
};
