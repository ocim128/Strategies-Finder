import type { PairSelectionRule } from "./types";

export const disjoint_thirds_minimax: PairSelectionRule = {
    key: "disjoint_thirds_minimax",
    name: "Disjoint Thirds Minimax",
    description: "Ranks the weakest directional OLS slope across three disjoint 16-bar path segments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/disjoint_thirds_minimax.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_thirds_min_slope_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
