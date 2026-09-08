import type { PairSelectionRule } from "./types";

export const hedge_volatility_balance: PairSelectionRule = {
    key: "hedge_volatility_balance",
    name: "HEDGE_VOLATILITY_BALANCE",
    description: "Targets a chosen positive BASE-to-QUOTE volatility ratio.",
    defaultParams: { targetBaseQuoteVolRatio: 1 },
    paramLabels: { targetBaseQuoteVolRatio: "Target BASE/QUOTE volatility ratio" },
    score: (candidate, _event, params) => {
        const ratio = candidate.feat_legVolatilityRatio20;
        const target = params.targetBaseQuoteVolRatio!;
        if (ratio === null || ratio <= 0 || target <= 0) return Number.NEGATIVE_INFINITY;
        return -Math.abs(Math.log(ratio / target));
    },
};
