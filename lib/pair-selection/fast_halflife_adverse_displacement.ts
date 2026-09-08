import type { PairSelectionRule } from "./types";

export const fast_halflife_adverse_displacement: PairSelectionRule = {
    key: "fast_halflife_adverse_displacement",
    name: "Fast Half-Life Adverse Displacement",
    description: "Ranks adverse 48-bar z-score displacement divided by AR(1) half-life.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_zscore_b48_r1",
                "feat_fp_dependence_ar1_half_life_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/fast_halflife_adverse_displacement.ts"],
    },
    score: (candidate) => {
        const zscore = candidate.feat_fp_spread_zscore_b48_r1;
        const halfLife = candidate.feat_fp_dependence_ar1_half_life_b48_r1;
        if (zscore === null || halfLife === null || halfLife <= 0) return Number.NEGATIVE_INFINITY;
        const adverseZscore = candidate.direction === "long" ? -zscore : zscore;
        return adverseZscore / Math.max(1.0, halfLife);
    },
};
