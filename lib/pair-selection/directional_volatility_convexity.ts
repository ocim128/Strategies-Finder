import type { PairSelectionRule } from "./types";

export const directional_volatility_convexity: PairSelectionRule = {
    key: "directional_volatility_convexity",
    name: "Directional Volatility Convexity",
    description: "Ranks the favorable share of 48-bar spread-return variance.",
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
        sourceFiles: ["lib/pair-selection/directional_volatility_convexity.ts"],
    },
    score: (candidate) => {
        const fav = candidate.direction === "long"
            ? candidate.feat_fp_volatility_upside_rms_b48_r1
            : candidate.feat_fp_volatility_downside_rms_b48_r1;
        const adv = candidate.direction === "long"
            ? candidate.feat_fp_volatility_downside_rms_b48_r1
            : candidate.feat_fp_volatility_upside_rms_b48_r1;
        if (fav === null || adv === null || (fav === 0 && adv === 0)) return Number.NEGATIVE_INFINITY;
        return (fav * fav) / (fav * fav + adv * adv);
    },
};
