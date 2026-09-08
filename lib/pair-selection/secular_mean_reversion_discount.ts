import type { PairSelectionRule } from "./types";

export const secular_mean_reversion_discount: PairSelectionRule = {
    key: "secular_mean_reversion_discount",
    name: "Secular Mean Reversion Discount",
    description: "Ranks 240-bar spread return opposite to the signal direction.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: ["feat_fp_spread_log_return_b240_r1"],
        },
        sourceFiles: ["lib/pair-selection/secular_mean_reversion_discount.ts"],
    },
    score: (candidate) => {
        const ret240 = candidate.feat_fp_spread_log_return_b240_r1;
        if (ret240 === null || !Number.isFinite(ret240)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? -ret240 : ret240;
    },
};
