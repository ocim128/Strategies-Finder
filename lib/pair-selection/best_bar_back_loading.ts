import type { PairSelectionRule } from "./types";

export const best_bar_back_loading: PairSelectionRule = {
    key: "best_bar_back_loading",
    name: "Best Bar Back Loading",
    description: "Prefers candidates whose largest direction-adjusted increment occurred most recently in the window.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/best_bar_back_loading.ts"],
    },
    score: (candidate) => {
        const index = candidate.feat_fp_spread_best_bar_index_b48_r1;
        return index === null || !Number.isFinite(index) ? Number.NEGATIVE_INFINITY : -index;
    },
};
