import type { PairSelectionRule } from "./types";

export const laplace_expected_gross_edge: PairSelectionRule = {
    key: "laplace_expected_gross_edge",
    name: "Laplace Expected Gross Edge",
    description: "Ranks Laplace win probability multiplied by rolling trade profit factor.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_trade_profit_factor_t8_r1"],
        },
        sourceFiles: ["lib/pair-selection/laplace_expected_gross_edge.ts"],
    },
    score: (candidate) => {
        const wr = candidate.feat_pairWinRatePrior;
        const trades = candidate.feat_pairTradesPrior;
        const pf = candidate.feat_fp_trade_profit_factor_t8_r1;
        if (wr === null || trades < 0 || pf === null || pf <= 0) return Number.NEGATIVE_INFINITY;
        const wins = Math.round(trades * (wr / 100));
        const p = (wins + 1) / (trades + 2);
        return p * pf;
    },
};
