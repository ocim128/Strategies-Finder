import { medianValid, memoByPool, sharedLegOverlapFraction } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const uncrowded_alpha_shrinkage: PairSelectionRule = {
    key: "uncrowded_alpha_shrinkage",
    name: "Uncrowded Alpha Shrinkage",
    description: "Scales Bayesian-shrunk lifetime win rate by same-event leg uniqueness.",
    defaultParams: { crowdingPenalty: 0.8 },
    paramLabels: { crowdingPenalty: "Penalty multiplier applied per unit of shared-leg overlap fraction" },
    metadata: {
        sourceFiles: ["lib/pair-selection/uncrowded_alpha_shrinkage.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const wr = candidate.feat_pairWinRatePrior;
        const trades = candidate.feat_pairTradesPrior;
        const med = memoByPool(pool, "pwr-med", () => medianValid(pool, (entry) => entry.feat_pairWinRatePrior));
        const overlap = sharedLegOverlapFraction(candidate, pool);
        if (wr === null || med === null || trades + 5 <= 0) return Number.NEGATIVE_INFINITY;
        const shrunk = (wr * trades + med * 5) / (trades + 5);
        return shrunk * (1 - (overlap ?? 0) * params.crowdingPenalty!);
    },
};
