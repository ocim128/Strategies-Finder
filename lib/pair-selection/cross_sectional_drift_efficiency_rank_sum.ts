import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface DriftEfficiencyRanks {
    slope: readonly number[];
    efficiency: readonly number[];
}

function percentileRank(values: readonly number[], value: number): number {
    if (values.length === 0) return Number.NaN;
    if (values.length === 1) return 0.5;
    let less = 0;
    let equal = 0;
    for (const entry of values) {
        if (entry < value) less += 1;
        else if (entry === value) equal += 1;
    }
    return (less + (equal - 1) / 2) / (values.length - 1);
}

export const cross_sectional_drift_efficiency_rank_sum: PairSelectionRule = {
    key: "cross_sectional_drift_efficiency_rank_sum",
    name: "Cross-Sectional Drift Efficiency Rank Sum",
    description: "Ranks the sum of event-level direction-aligned drift and efficiency percentiles.",
    defaultParams: { efficiencyRankWeight: 1.0 },
    paramLabels: { efficiencyRankWeight: "Weight on efficiency percentile rank relative to directional drift rank" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/cross_sectional_drift_efficiency_rank_sum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const ranks = memoByPool(pool, "cross-sectional-drift-efficiency-ranks", (): DriftEfficiencyRanks => ({
            slope: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b48_r2))
                .filter((value): value is number => value !== null),
            efficiency: pool
                .map((entry) => entry.feat_fp_spread_efficiency_ratio_b48_r1)
                .filter((value): value is number => value !== null && Number.isFinite(value)),
        }));
        const slope = directionAdjusted(candidate, candidate.feat_fp_spread_ols_slope_b48_r2);
        const efficiency = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (slope === null || efficiency === null) return Number.NEGATIVE_INFINITY;
        return percentileRank(ranks.slope, slope) + params.efficiencyRankWeight! * percentileRank(ranks.efficiency, efficiency);
    },
};
