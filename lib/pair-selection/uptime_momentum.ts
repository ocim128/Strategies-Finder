import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const uptime_momentum: PairSelectionRule = {
    key: "uptime_momentum",
    name: "Uptime Momentum",
    description: "Weights directional 48-bar spread drift by the fraction of path closes at or above the opening level.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/uptime_momentum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const uptime = candidate.feat_fp_spread_uptime_fraction_b48_r1;
        if (return48 === null || uptime === null || !Number.isFinite(uptime)) return Number.NEGATIVE_INFINITY;
        return return48 * uptime;
    },
};
