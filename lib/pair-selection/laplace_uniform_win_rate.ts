import type { PairSelectionRule } from "./types";

export const laplace_uniform_win_rate: PairSelectionRule = {
    key: "laplace_uniform_win_rate",
    name: "Laplace Uniform Win Rate",
    description: "Ranks the parameter-free Laplace rule-of-succession win probability.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/laplace_uniform_win_rate.ts"],
    },
    score: (candidate) => {
        const wr = candidate.feat_pairWinRatePrior;
        const n = candidate.feat_pairTradesPrior;
        if (wr === null || n < 0) return Number.NEGATIVE_INFINITY;
        const wins = Math.round(n * (wr / 100));
        return (wins + 1) / (n + 2);
    },
};
