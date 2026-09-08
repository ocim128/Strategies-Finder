import type { PairSelectionRule } from "./types";

export const analytical_kelly_criterion_allocation: PairSelectionRule = {
    key: "analytical_kelly_criterion_allocation",
    name: "Analytical Kelly Criterion Allocation",
    description: "Ranks the closed-form Kelly fraction from shrunk win probability and rolling profit factor.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_trade_profit_factor_t8_r1"] },
        sourceFiles: ["lib/pair-selection/analytical_kelly_criterion_allocation.ts"],
    },
    score: (candidate) => {
        const wr = candidate.feat_pairWinRatePrior;
        const trades = candidate.feat_pairTradesPrior;
        const pf = candidate.feat_fp_trade_profit_factor_t8_r1;
        if (wr === null || trades <= 0 || pf === null || pf <= 0) return Number.NEGATIVE_INFINITY;
        const p = ((wr * trades + 28 * 5) / (trades + 5)) / 100;
        return p - (1 / pf);
    },
};
