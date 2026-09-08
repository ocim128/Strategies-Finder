import type { PairSelectionRule } from "./types";

export const favorable_volatility_share: PairSelectionRule = {
    key: "favorable_volatility_share",
    name: "Favorable Volatility Share",
    description: "Ranks the favorable share of acute 12-bar directional volatility.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_volatility_upside_rms_b12_r1",
                "feat_fp_volatility_downside_rms_b12_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/favorable_volatility_share.ts"],
    },
    score: (candidate) => {
        const up = candidate.feat_fp_volatility_upside_rms_b12_r1;
        const down = candidate.feat_fp_volatility_downside_rms_b12_r1;
        if (up === null || down === null || up + down <= 0) return Number.NEGATIVE_INFINITY;
        const fav = candidate.direction === "long" ? up : down;
        return fav / (up + down);
    },
};
