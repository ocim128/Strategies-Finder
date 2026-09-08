import type { PairSelectionRule } from "./types";

export const consecutive_spread_increment_momentum: PairSelectionRule = {
    key: "consecutive_spread_increment_momentum",
    name: "Consecutive Spread Increment Momentum",
    description: "Ranks consecutive directional spread close increments before the signal bar.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_spread_up_increment_streak_r1",
                "feat_fp_spread_down_increment_streak_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/consecutive_spread_increment_momentum.ts"],
    },
    score: (candidate) => {
        const streak = candidate.direction === "long"
            ? candidate.feat_fp_spread_up_increment_streak_r1
            : candidate.feat_fp_spread_down_increment_streak_r1;
        if (streak === null || streak < 0) return Number.NEGATIVE_INFINITY;
        return streak;
    },
};
