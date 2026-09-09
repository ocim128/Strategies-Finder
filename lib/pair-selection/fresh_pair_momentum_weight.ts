import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

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

export const fresh_pair_momentum_weight: PairSelectionRule = {
    key: "fresh_pair_momentum_weight",
    name: "Fresh Pair Momentum Weight",
    description: "Weights directional 48-bar momentum toward candidates with fewer prior pair trades.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/fresh_pair_momentum_weight.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const tradesPrior = candidate.feat_pairTradesPrior;
        if (return48 === null || !Number.isFinite(tradesPrior)) return Number.NEGATIVE_INFINITY;
        const values = memoByPool(pool, "fresh-pair-momentum-weight-trade-counts", () => pool
            .map((entry) => entry.feat_pairTradesPrior)
            .filter((value): value is number => Number.isFinite(value)));
        if (values.length === 0) return Number.NEGATIVE_INFINITY;
        return return48 * (1 - percentileRank(values, tradesPrior));
    },
};
