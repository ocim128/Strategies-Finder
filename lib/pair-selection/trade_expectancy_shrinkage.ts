import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const trade_expectancy_shrinkage: PairSelectionRule = {
    key: "trade_expectancy_shrinkage",
    name: "Trade Expectancy Shrinkage",
    description: "Shrinks the rolling 8-trade mean net PnL percentage toward the event-median expectancy.",
    defaultParams: { priorStrength: 5 },
    paramLabels: { priorStrength: "Prior trade count weight for Bayesian shrinkage" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_trade_mean_net_pct_t8_r1", "feat_fp_trade_mean_net_pct_t8_r1_n"],
        },
        sourceFiles: ["lib/pair-selection/trade_expectancy_shrinkage.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const pnl = candidate.feat_fp_trade_mean_net_pct_t8_r1;
        const n = candidate.feat_fp_trade_mean_net_pct_t8_r1_n;
        const med = memoByPool(pool, "t8-pnl-med", () => medianValid(pool, (entry) => entry.feat_fp_trade_mean_net_pct_t8_r1));
        if (pnl === null || n === null || n < 4 || med === null) return Number.NEGATIVE_INFINITY;
        return (pnl * n + med * params.priorStrength!) / (n + params.priorStrength!);
    },
};
