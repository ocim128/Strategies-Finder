import type { PairSelectionRule } from "./types";

export const efficiency_weighted_clean_atr: PairSelectionRule = {
    key: "efficiency_weighted_clean_atr",
    name: "Efficiency Weighted Clean ATR",
    description: "Multiplies signal ATR percentage by 48-bar spread efficiency.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_spread_efficiency_ratio_b48_r1"] },
        sourceFiles: ["lib/pair-selection/efficiency_weighted_clean_atr.ts"],
    },
    score: (candidate) => {
        const atr = candidate.feat_atrPct;
        const eff = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (atr === null || eff === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return atr * eff;
    },
};
