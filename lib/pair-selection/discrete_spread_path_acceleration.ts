import type { PairSelectionRule } from "./types";

export const discrete_spread_path_acceleration: PairSelectionRule = {
    key: "discrete_spread_path_acceleration",
    name: "Discrete Spread Path Acceleration",
    description: "Ranks direction-aligned finite-difference acceleration from 12-bar and 48-bar returns.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/discrete_spread_path_acceleration.ts"],
    },
    score: (candidate) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        if (ret12 === null || ret48 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * (4 * ret12 - ret48);
    },
};
