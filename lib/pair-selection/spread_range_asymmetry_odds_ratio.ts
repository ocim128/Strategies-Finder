import type { PairSelectionRule } from "./types";

export const spread_range_asymmetry_odds_ratio: PairSelectionRule = {
    key: "spread_range_asymmetry_odds_ratio",
    name: "Spread Range Asymmetry Odds Ratio",
    description: "Ranks direction-aligned favorable range distance relative to adverse range distance.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_distance_above_min_b48_r1",
                "feat_fp_spread_distance_below_max_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/spread_range_asymmetry_odds_ratio.ts"],
    },
    score: (candidate) => {
        const aboveMin = candidate.feat_fp_spread_distance_above_min_b48_r1;
        const belowMax = candidate.feat_fp_spread_distance_below_max_b48_r1;
        if (aboveMin === null || belowMax === null || belowMax <= 0 || aboveMin <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? aboveMin / belowMax : belowMax / aboveMin;
    },
};
