import type { PairCandidate, PairSelectionRule } from "./types";

type CandidateWithLosingStreak = PairCandidate & {
    feat_pairLosingStreakPrior?: number | null;
};

export const pair_losing_streak_rebound: PairSelectionRule = {
    key: "pair_losing_streak_rebound",
    name: "PAIR_LOSING_STREAK_REBOUND",
    description: "Targets a moderate prior losing-trade streak for cyclical pair recovery.",
    defaultParams: { targetLosingStreak: 2 },
    paramLabels: { targetLosingStreak: "Target losing streak (trades)" },
    metadata: {
        featureRequirements: { libraryRelease: "v1", columns: ["feat_pairLosingStreakPrior"] },
        sourceFiles: ["lib/pair-selection/pair_losing_streak_rebound.ts"],
    },
    score: (candidate, _event, params) => {
        const losingStreak = (candidate as CandidateWithLosingStreak).feat_pairLosingStreakPrior ?? null;
        if (losingStreak === null || !Number.isFinite(losingStreak)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(losingStreak - params.targetLosingStreak!);
    },
};
