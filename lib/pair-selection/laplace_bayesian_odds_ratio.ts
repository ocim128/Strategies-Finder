import type { PairSelectionRule } from "./types";

export const laplace_bayesian_odds_ratio: PairSelectionRule = {
    key: "laplace_bayesian_odds_ratio",
    name: "Laplace Bayesian Odds Ratio",
    description: "Ranks Laplace posterior evidence odds from lifetime pair wins and losses.",
    defaultParams: { skepticism: 1 },
    paramLabels: { skepticism: "Pseudo-loss evidence weight representing prior skepticism" },
    metadata: {
        sourceFiles: ["lib/pair-selection/laplace_bayesian_odds_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const wr = candidate.feat_pairWinRatePrior;
        const n = candidate.feat_pairTradesPrior;
        if (wr === null || n <= 0) return Number.NEGATIVE_INFINITY;
        const wins = Math.round(n * (wr / 100));
        const losses = n - wins;
        return (wins + 1) / (losses + 1 + params.skepticism!);
    },
};
