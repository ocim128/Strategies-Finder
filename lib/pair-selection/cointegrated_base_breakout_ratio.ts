import type { PairSelectionRule } from "./types";

export const cointegrated_base_breakout_ratio: PairSelectionRule = {
    key: "cointegrated_base_breakout_ratio",
    name: "Cointegrated Base Breakout Ratio",
    description: "Ranks 48-bar directional z-score after penalizing secular z-score extension.",
    defaultParams: { secularAnchorPenalty: 1.0 },
    paramLabels: { secularAnchorPenalty: "Penalty weight applied to absolute 240-bar z-score" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_zscore_b48_r1",
                "feat_fp_spread_zscore_b240_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/cointegrated_base_breakout_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const zscore48 = candidate.feat_fp_spread_zscore_b48_r1;
        const zscore240 = candidate.feat_fp_spread_zscore_b240_r1;
        if (zscore48 === null || zscore240 === null) return Number.NEGATIVE_INFINITY;
        const directionalZscore48 = candidate.direction === "long" ? zscore48 : -zscore48;
        return directionalZscore48 / (1 + params.secularAnchorPenalty! * Math.abs(zscore240));
    },
};
