import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

interface RankAccelerationValues {
    ret12: readonly number[];
    ret48: readonly number[];
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

export const cross_sectional_rank_acceleration: PairSelectionRule = {
    key: "cross_sectional_rank_acceleration",
    name: "Cross-Sectional Rank Acceleration",
    description: "Ranks 12-bar directional return percentile minus weighted 48-bar percentile.",
    defaultParams: { intermediateRankDeduction: 0.5 },
    paramLabels: { intermediateRankDeduction: "Fraction of 48-bar rank subtracted from 12-bar rank" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/cross_sectional_rank_acceleration.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const ranks = memoByPool(pool, "cross-sectional-rank-acceleration-values", (): RankAccelerationValues => ({
            ret12: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1))
                .filter((value): value is number => value !== null),
            ret48: pool
                .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
                .filter((value): value is number => value !== null),
        }));
        const ret12 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b12_r1);
        const ret48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (ret12 === null || ret48 === null) return Number.NEGATIVE_INFINITY;
        return percentileRank(ranks.ret12, ret12) - params.intermediateRankDeduction! * percentileRank(ranks.ret48, ret48);
    },
};
