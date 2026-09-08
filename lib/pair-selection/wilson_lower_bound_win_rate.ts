import type { PairSelectionRule } from "./types";

export const wilson_lower_bound_win_rate: PairSelectionRule = {
    key: "wilson_lower_bound_win_rate",
    name: "Wilson Lower Bound Win Rate",
    description: "Ranks the Wilson score lower bound of each pair's lifetime win rate.",
    defaultParams: { zScore: 1.96 },
    paramLabels: { zScore: "Standard normal critical value for binomial confidence interval" },
    metadata: {
        sourceFiles: ["lib/pair-selection/wilson_lower_bound_win_rate.ts"],
    },
    score: (candidate, _event, params) => {
        const wr = candidate.feat_pairWinRatePrior;
        const n = candidate.feat_pairTradesPrior;
        if (wr === null || n <= 0) return Number.NEGATIVE_INFINITY;
        const p = wr / 100;
        const z = params.zScore!;
        const denom = 1 + (z * z) / n;
        const center = p + (z * z) / (2 * n);
        const rad = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
        return (center - rad) / denom;
    },
};
