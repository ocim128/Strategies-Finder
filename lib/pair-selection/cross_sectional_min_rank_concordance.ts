import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface MinRankValues {
    ret12: readonly number[];
    slope48: readonly number[];
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

export const cross_sectional_min_rank_concordance: PairSelectionRule = {
    key: "cross_sectional_min_rank_concordance",
    name: "Cross-Sectional Min-Rank Concordance",
    description: "Ranks candidates by the weaker of short-term return and intermediate drift percentiles.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_ols_slope_b48_r2",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/cross_sectional_min_rank_concordance.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const ranks = memoByPool(pool, "cross-sectional-min-rank-values", (): MinRankValues => ({
            ret12: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1))
                .filter((value): value is number => value !== null),
            slope48: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b48_r2))
                .filter((value): value is number => value !== null),
        }));
        const ret12 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b12_r1);
        const slope48 = directionAdjusted(candidate, candidate.feat_fp_spread_ols_slope_b48_r2);
        if (ret12 === null || slope48 === null) return Number.NEGATIVE_INFINITY;
        return Math.min(percentileRank(ranks.ret12, ret12), percentileRank(ranks.slope48, slope48));
    },
};
