import type { PairSelectionRule } from "./types";

export const low_efficiency_exhaustion_spring: PairSelectionRule = {
    key: "low_efficiency_exhaustion_spring",
    name: "Low Efficiency Exhaustion Spring",
    description: "Scales adverse 48-bar return by the complement of spread efficiency.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/low_efficiency_exhaustion_spring.ts"],
    },
    score: (candidate) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (ret48 === null || efficiency === null) return Number.NEGATIVE_INFINITY;
        const adverseRet48 = candidate.direction === "long" ? -ret48 : ret48;
        return adverseRet48 * (1.0 - efficiency);
    },
};
