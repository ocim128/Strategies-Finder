import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const recent_trade_win_rate_shrinkage: PairSelectionRule = {
    key: "recent_trade_win_rate_shrinkage",
    name: "Recent Trade Win Rate Shrinkage",
    description: "Shrinks the rolling 8-trade win fraction toward the contemporaneous event median.",
    defaultParams: { priorStrength: 5 },
    paramLabels: { priorStrength: "Prior trade count weight for Bayesian shrinkage" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: ["feat_fp_trade_win_fraction_t8_r1", "feat_fp_trade_win_fraction_t8_r1_n"],
        },
        sourceFiles: ["lib/pair-selection/recent_trade_win_rate_shrinkage.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const wr = candidate.feat_fp_trade_win_fraction_t8_r1;
        const n = candidate.feat_fp_trade_win_fraction_t8_r1_n;
        const med = memoByPool(pool, "t8-win-med", () => medianValid(pool, (entry) => entry.feat_fp_trade_win_fraction_t8_r1));
        if (wr === null || n === null || n < 4 || med === null) return Number.NEGATIVE_INFINITY;
        return (wr * n + med * params.priorStrength!) / (n + params.priorStrength!);
    },
};
