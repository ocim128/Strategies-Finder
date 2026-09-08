import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const trade_history_gated_win_shrinkage: PairSelectionRule = {
    key: "trade_history_gated_win_shrinkage",
    name: "Trade History Gated Win Shrinkage",
    description: "Shrinks lifetime pair win rate toward the event median after a minimum trade-count gate.",
    defaultParams: { minTrades: 10 },
    paramLabels: { minTrades: "Minimum historical closed trades required for eligibility" },
    metadata: {
        sourceFiles: ["lib/pair-selection/trade_history_gated_win_shrinkage.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const wr = candidate.feat_pairWinRatePrior;
        const trades = candidate.feat_pairTradesPrior;
        const med = memoByPool(pool, "pwr-med", () => medianValid(pool, (entry) => entry.feat_pairWinRatePrior));
        if (wr === null || trades < params.minTrades! || med === null) return Number.NEGATIVE_INFINITY;
        return (wr * trades + med * 5) / (trades + 5);
    },
};
