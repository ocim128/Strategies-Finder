import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

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

export const cross_sectional_adverse_return_rank: PairSelectionRule = {
    key: "cross_sectional_adverse_return_rank",
    name: "Cross-Sectional Adverse Return Rank",
    description: "Ranks adverse 48-bar return percentile within the simultaneous fire crowd.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cross_sectional_adverse_return_rank.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        if (pool.length < 2) return Number.NEGATIVE_INFINITY;
        const adverseReturns = memoByPool(pool, "cross-sectional-adverse-return-ranks", (): readonly number[] => pool
            .map((entry) => {
                const directionalReturn = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
                return directionalReturn === null ? null : -directionalReturn;
            })
            .filter((value): value is number => value !== null));
        const directionalReturn = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (directionalReturn === null) return Number.NEGATIVE_INFINITY;
        return percentileRank(adverseReturns, -directionalReturn);
    },
};
