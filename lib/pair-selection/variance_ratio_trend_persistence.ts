import type { PairSelectionRule } from "./types";

export const variance_ratio_trend_persistence: PairSelectionRule = {
    key: "variance_ratio_trend_persistence",
    name: "Variance Ratio Trend Persistence",
    description: "Scales direction-aligned 48-bar spread return by its variance ratio.",
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
        sourceFiles: ["lib/pair-selection/variance_ratio_trend_persistence.ts"],
    },
    score: (candidate) => {
        const spreadReturn = candidate.feat_fp_spread_log_return_b48_r1;
        const ret = candidate.direction === "long"
            ? spreadReturn
            : (spreadReturn === null ? null : -spreadReturn);
        const vr = candidate.feat_fp_dependence_variance_ratio_b48_h4_r1;
        if (ret === null || vr === null || vr <= 0) return Number.NEGATIVE_INFINITY;
        return ret * vr;
    },
};
