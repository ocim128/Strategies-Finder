import type { PairSelectionRule } from "./types";

export const spread_efficiency_acceleration_ratio: PairSelectionRule = {
    key: "spread_efficiency_acceleration_ratio",
    name: "Spread Efficiency Acceleration Ratio",
    description: "Scales direction-aligned 48-bar return by fast-to-intermediate efficiency.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_efficiency_ratio_b12_r1",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/spread_efficiency_acceleration_ratio.ts"],
    },
    score: (candidate) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const efficiency12 = candidate.feat_fp_spread_efficiency_ratio_b12_r1;
        const efficiency48 = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (ret48 === null || efficiency12 === null || efficiency48 === null || efficiency48 <= 0) {
            return Number.NEGATIVE_INFINITY;
        }
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 * (efficiency12 / efficiency48);
    },
};
