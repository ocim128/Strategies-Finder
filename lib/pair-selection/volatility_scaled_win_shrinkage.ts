import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const volatility_scaled_win_shrinkage: PairSelectionRule = {
    key: "volatility_scaled_win_shrinkage",
    name: "Volatility Scaled Win Shrinkage",
    description: "Scales Bayesian-shrunk lifetime pair win rate by current ATR percentage.",
    defaultParams: { atrExponent: 1.0 },
    paramLabels: { atrExponent: "Power exponent scaling ATR percentage relative to shrunk win rate" },
    metadata: {
        sourceFiles: ["lib/pair-selection/volatility_scaled_win_shrinkage.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const wr = candidate.feat_pairWinRatePrior;
        const trades = candidate.feat_pairTradesPrior;
        const atr = candidate.feat_atrPct;
        const med = memoByPool(pool, "pwr-med", () => medianValid(pool, (entry) => entry.feat_pairWinRatePrior));
        if (wr === null || atr === null || atr <= 0 || med === null || trades + 5 <= 0) return Number.NEGATIVE_INFINITY;
        const shrunk = (wr * trades + med * 5) / (trades + 5);
        return shrunk * Math.pow(atr, params.atrExponent!);
    },
};
