import type { PairSelectionRule } from "./types";

export const worst_bar_front_loading: PairSelectionRule = {
    key: "worst_bar_front_loading",
    name: "Worst Bar Front Loading",
    description: "Prefers candidates whose worst direction-adjusted path increment occurred earliest in the window.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_worst_bar_index_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/worst_bar_front_loading.ts"],
    },
    score: (candidate) => {
        const index = candidate.feat_fp_spread_worst_bar_index_b48_r1;
        return index === null ? Number.NEGATIVE_INFINITY : -index;
    },
};
