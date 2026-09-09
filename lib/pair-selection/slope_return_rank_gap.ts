import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface RankGapValues {
    slopes: readonly number[];
    returns: readonly number[];
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

function buildRankGapValues(pool: readonly PairCandidate[]): RankGapValues {
    return {
        slopes: pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b48_r2))
            .filter((value): value is number => value !== null),
        returns: pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
            .filter((value): value is number => value !== null),
    };
}

export const slope_return_rank_gap: PairSelectionRule = {
    key: "slope_return_rank_gap",
    name: "Slope Return Rank Gap",
    description: "Ranks the event percentile gap between directional fitted slope and realized return.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/slope_return_rank_gap.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const slope = directionAdjusted(candidate, candidate.feat_fp_spread_ols_slope_b48_r2);
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (slope === null || return48 === null) return Number.NEGATIVE_INFINITY;
        const values = memoByPool(pool, "slope-return-rank-gap-values", () => buildRankGapValues(pool));
        return percentileRank(values.slopes, slope) - percentileRank(values.returns, return48);
    },
};
