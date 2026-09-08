import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const joint_shrunk_win_expectancy_product: PairSelectionRule = {
    key: "joint_shrunk_win_expectancy_product",
    name: "Joint Shrunk Win Expectancy Product",
    description: "Multiplies shrunk lifetime win rate by rolling mean net trade return.",
    defaultParams: { priorStrength: 5 },
    paramLabels: { priorStrength: "Prior trade count weight for Bayesian win-rate shrinkage" },
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_trade_mean_net_pct_t8_r1"] },
        sourceFiles: ["lib/pair-selection/joint_shrunk_win_expectancy_product.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const wr = candidate.feat_pairWinRatePrior;
        const trades = candidate.feat_pairTradesPrior;
        const pnl = candidate.feat_fp_trade_mean_net_pct_t8_r1;
        const med = memoByPool(pool, "pwr-med", () => medianValid(pool, (entry) => entry.feat_pairWinRatePrior));
        if (wr === null || med === null || pnl === null || trades + params.priorStrength! <= 0) return Number.NEGATIVE_INFINITY;
        const shrunk = (wr * trades + med * params.priorStrength!) / (trades + params.priorStrength!);
        return shrunk * pnl;
    },
};
