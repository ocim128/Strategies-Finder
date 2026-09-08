import type { PairSelectionRule } from "./types";

export const directional_skew_normalized_atr: PairSelectionRule = {
    key: "directional_skew_normalized_atr",
    name: "Directional Skew Normalized ATR",
    description: "Ranks directional volatility skew scaled by signal ATR percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_volatility_upside_rms_b48_r1",
                "feat_fp_volatility_downside_rms_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_skew_normalized_atr.ts"],
    },
    score: (candidate) => {
        const fav = candidate.direction === "long"
            ? candidate.feat_fp_volatility_upside_rms_b48_r1
            : candidate.feat_fp_volatility_downside_rms_b48_r1;
        const adv = candidate.direction === "long"
            ? candidate.feat_fp_volatility_downside_rms_b48_r1
            : candidate.feat_fp_volatility_upside_rms_b48_r1;
        const atr = candidate.feat_atrPct;
        if (fav === null || adv === null || atr === null || fav + adv <= 0 || atr <= 0) return Number.NEGATIVE_INFINITY;
        return ((fav - adv) / (fav + adv)) * atr;
    },
};
