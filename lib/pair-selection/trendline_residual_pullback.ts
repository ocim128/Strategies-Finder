import type { PairSelectionRule } from "./types";

export const trendline_residual_pullback: PairSelectionRule = {
    key: "trendline_residual_pullback",
    name: "Trendline Residual Pullback",
    description: "Prefers direction-adjusted paths ending below their fitted 48-bar trendline.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/trendline_residual_pullback.ts"],
    },
    score: (candidate) => {
        const residual = candidate.feat_fp_spread_trendline_residual_b48_r1;
        return residual === null || !Number.isFinite(residual) ? Number.NEGATIVE_INFINITY : -residual;
    },
};
