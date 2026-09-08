import type { PairSelectionRule } from "./types";

export const directional_increment_streak_persistence: PairSelectionRule = {
    key: "directional_increment_streak_persistence",
    name: "Directional Increment Streak Persistence",
    description: "Ranks the length of the current direction-aligned spread increment streak.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_up_increment_streak_r1",
                "feat_fp_spread_down_increment_streak_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_increment_streak_persistence.ts"],
    },
    score: (candidate) => {
        const streak = candidate.direction === "long"
            ? candidate.feat_fp_spread_up_increment_streak_r1
            : candidate.feat_fp_spread_down_increment_streak_r1;
        if (streak === null || streak <= 0) return Number.NEGATIVE_INFINITY;
        return streak;
    },
};
