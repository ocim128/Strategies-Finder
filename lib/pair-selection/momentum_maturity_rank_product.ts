import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface MomentumMaturityValues {
    momentum: readonly number[];
    maturity: readonly number[];
}

function percentileRank(values: readonly number[], value: number): number {
    if (values.length <= 1) return 0.5;
    let less = 0;
    let equal = 0;
    for (const entry of values) {
        if (entry < value) less += 1;
        else if (entry === value) equal += 1;
    }
    return (less + (equal - 1) / 2) / (values.length - 1);
}

export const momentum_maturity_rank_product: PairSelectionRule = {
    key: "momentum_maturity_rank_product",
    name: "Momentum Maturity Rank Product",
    description: "Multiplies event percentiles of directional momentum and prior pair-trade count.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/momentum_maturity_rank_product.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const tradesPrior = Number.isFinite(candidate.feat_pairTradesPrior) ? candidate.feat_pairTradesPrior : null;
        if (return48 === null || tradesPrior === null) return Number.NEGATIVE_INFINITY;
        const values = memoByPool(pool, "momentum-maturity-rank-product-values", (): MomentumMaturityValues => ({
            momentum: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
                .filter((value): value is number => value !== null),
            maturity: pool
                .map((entry) => entry.feat_pairTradesPrior)
                .filter((value): value is number => Number.isFinite(value)),
        }));
        if (values.momentum.length === 0 || values.maturity.length === 0) return Number.NEGATIVE_INFINITY;
        return percentileRank(values.momentum, return48) * percentileRank(values.maturity, tradesPrior);
    },
};
