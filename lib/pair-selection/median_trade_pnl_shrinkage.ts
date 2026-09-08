import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const median_trade_pnl_shrinkage: PairSelectionRule = {
    key: "median_trade_pnl_shrinkage",
    name: "Median Trade PnL Shrinkage",
    description: "Shrinks rolling 8-trade median net PnL toward the event-median median PnL.",
    defaultParams: { priorStrength: 5 },
    paramLabels: { priorStrength: "Prior trade count weight for Bayesian shrinkage" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_trade_median_net_pct_t8_r1", "feat_fp_trade_median_net_pct_t8_r1_n"],
        },
        sourceFiles: ["lib/pair-selection/median_trade_pnl_shrinkage.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const medPnl = candidate.feat_fp_trade_median_net_pct_t8_r1;
        const n = candidate.feat_fp_trade_median_net_pct_t8_r1_n;
        const eventMed = memoByPool(pool, "t8-medpnl-med", () => medianValid(pool, (entry) => entry.feat_fp_trade_median_net_pct_t8_r1));
        if (medPnl === null || n === null || n < 4 || eventMed === null) return Number.NEGATIVE_INFINITY;
        return (medPnl * n + eventMed * params.priorStrength!) / (n + params.priorStrength!);
    },
};
