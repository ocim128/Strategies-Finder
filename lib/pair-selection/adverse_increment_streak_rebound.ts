import type { PairSelectionRule } from "./types";

export const adverse_increment_streak_rebound: PairSelectionRule = {
    key: "adverse_increment_streak_rebound",
    name: "Adverse Increment Streak Rebound",
    description: "Ranks the length of the direction-opposed spread increment streak.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_down_increment_streak_r1",
                "feat_fp_spread_up_increment_streak_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/adverse_increment_streak_rebound.ts"],
    },
    score: (candidate) => {
        const streak = candidate.direction === "long"
            ? candidate.feat_fp_spread_down_increment_streak_r1
            : candidate.feat_fp_spread_up_increment_streak_r1;
        if (streak === null || streak <= 0) return Number.NEGATIVE_INFINITY;
        return streak;
    },
};
