import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const pair_win_rate_shrinkage: PairSelectionRule = {
    key: "pair_win_rate_shrinkage",
    name: "PAIR_WIN_RATE_SHRINKAGE",
    description: "Shrinks each pair's prior win rate toward the event-median prior.",
    defaultParams: { priorStrengthTrades: 5 },
    paramLabels: { priorStrengthTrades: "Prior strength (trades)" },
    score: (candidate, _event, params, pool) => {
        const priorWinRate = candidate.feat_pairWinRatePrior;
        const eventMedian = memoByPool(pool, "pair-win-rate-median", () => medianValid(pool, (entry) => entry.feat_pairWinRatePrior));
        const priorStrength = params.priorStrengthTrades!;
        const denominator = candidate.feat_pairTradesPrior + priorStrength;
        if (priorWinRate === null || eventMedian === null || denominator <= 0) return Number.NEGATIVE_INFINITY;
        return (priorWinRate * candidate.feat_pairTradesPrior + eventMedian * priorStrength) / denominator;
    },
};
