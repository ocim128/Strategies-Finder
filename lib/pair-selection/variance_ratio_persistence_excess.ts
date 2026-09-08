import type { PairSelectionRule } from "./types";

export const variance_ratio_persistence_excess: PairSelectionRule = {
    key: "variance_ratio_persistence_excess",
    name: "Variance Ratio Persistence Excess",
    description: "Scales direction-aligned 48-bar return by variance-ratio excess over one.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_dependence_variance_ratio_b48_h4_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/variance_ratio_persistence_excess.ts"],
    },
    score: (candidate) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const varianceRatio = candidate.feat_fp_dependence_variance_ratio_b48_h4_r1;
        if (ret48 === null || varianceRatio === null) return Number.NEGATIVE_INFINITY;
        const dirRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return dirRet48 * (varianceRatio - 1.0);
    },
};
