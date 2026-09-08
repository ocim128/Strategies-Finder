import type { PairSelectionRule } from "./types";

export const profit_factor_regularized_shrinkage: PairSelectionRule = {
    key: "profit_factor_regularized_shrinkage",
    name: "Profit Factor Regularized Shrinkage",
    description: "Shrinks rolling 8-trade profit factor toward the neutral benchmark of 1.0.",
    defaultParams: { priorStrength: 4 },
    paramLabels: { priorStrength: "Prior weight pulling profit factor toward neutral 1.0" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_trade_profit_factor_t8_r1", "feat_fp_trade_profit_factor_t8_r1_n"],
        },
        sourceFiles: ["lib/pair-selection/profit_factor_regularized_shrinkage.ts"],
    },
    score: (candidate, _event, params) => {
        const pf = candidate.feat_fp_trade_profit_factor_t8_r1;
        const n = candidate.feat_fp_trade_profit_factor_t8_r1_n;
        if (pf === null || n === null || n < 4) return Number.NEGATIVE_INFINITY;
        return (Math.min(pf, 10) * n + 1.0 * params.priorStrength!) / (n + params.priorStrength!);
    },
};
