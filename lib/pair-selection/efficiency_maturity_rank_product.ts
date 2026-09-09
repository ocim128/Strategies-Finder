import { memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface EfficiencyMaturityValues {
    efficiency: readonly number[];
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

export const efficiency_maturity_rank_product: PairSelectionRule = {
    key: "efficiency_maturity_rank_product",
    name: "Efficiency Maturity Rank Product",
    description: "Multiplies event percentiles of spread efficiency and prior pair-trade count.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_efficiency_ratio_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/efficiency_maturity_rank_product.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        const maturity = Number.isFinite(candidate.feat_pairTradesPrior) ? candidate.feat_pairTradesPrior : null;
        if (efficiency === null || maturity === null) return Number.NEGATIVE_INFINITY;
        const values = memoByPool(pool, "efficiency-maturity-rank-product-values", (): EfficiencyMaturityValues => ({
            efficiency: pool
                .map((entry) => entry.feat_fp_spread_efficiency_ratio_b48_r1)
                .filter((value): value is number => value !== null && Number.isFinite(value)),
            maturity: pool
                .map((entry) => entry.feat_pairTradesPrior)
                .filter((value): value is number => Number.isFinite(value)),
        }));
        if (values.efficiency.length === 0 || values.maturity.length === 0) return Number.NEGATIVE_INFINITY;
        return percentileRank(values.efficiency, efficiency) * percentileRank(values.maturity, maturity);
    },
};
