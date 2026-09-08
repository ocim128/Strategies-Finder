import type { PairSelectionRule } from "./types";

export const spread_volatility_surge_ratio: PairSelectionRule = {
    key: "spread_volatility_surge_ratio",
    name: "Spread Volatility Surge Ratio",
    description: "Ranks the ratio of 12-bar to 240-bar spread-return volatility.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_fp_volatility_std_ratio_b12_over_b240_r1"] },
        sourceFiles: ["lib/pair-selection/spread_volatility_surge_ratio.ts"],
    },
    score: (candidate) => {
        const ratio = candidate.feat_fp_volatility_std_ratio_b12_over_b240_r1;
        if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return Number.NEGATIVE_INFINITY;
        return ratio;
    },
};
