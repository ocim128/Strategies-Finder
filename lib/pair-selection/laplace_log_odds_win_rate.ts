import type { PairSelectionRule } from "./types";

export const laplace_log_odds_win_rate: PairSelectionRule = {
    key: "laplace_log_odds_win_rate",
    name: "Laplace Log Odds Win Rate",
    description: "Ranks the natural log of Laplace-regularized historical win odds.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/laplace_log_odds_win_rate.ts"],
    },
    score: (candidate) => {
        const wr = candidate.feat_pairWinRatePrior;
        const n = candidate.feat_pairTradesPrior;
        if (wr === null || n <= 0) return Number.NEGATIVE_INFINITY;
        const wins = Math.round(n * (wr / 100));
        const losses = n - wins;
        return Math.log((wins + 1) / (losses + 1));
    },
};
