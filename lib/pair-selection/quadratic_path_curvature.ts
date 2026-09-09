import type { PairSelectionRule } from "./types";

export const quadratic_path_curvature: PairSelectionRule = {
    key: "quadratic_path_curvature",
    name: "Quadratic Path Curvature",
    description: "Ranks the quadratic coefficient of the direction-adjusted 48-bar spread path.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/quadratic_path_curvature.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_quadratic_curvature_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
