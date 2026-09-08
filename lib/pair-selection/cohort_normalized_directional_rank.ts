import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

type DirectionalRanks = ReadonlyMap<PairCandidate["direction"], readonly number[]>;

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

export const cohort_normalized_directional_rank: PairSelectionRule = {
    key: "cohort_normalized_directional_rank",
    name: "Cohort Normalized Directional Rank",
    description: "Ranks direction-aligned 48-bar return within the candidate's direction cohort.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/cohort_normalized_directional_rank.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const dirRet48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (dirRet48 === null) return Number.NEGATIVE_INFINITY;
        const cohorts = memoByPool(pool, "cohort-normalized-directional-ranks", (): DirectionalRanks => {
            const ranks = new Map<PairCandidate["direction"], number[]>();
            for (const entry of pool) {
                const ret48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
                if (ret48 === null) continue;
                const cohort = ranks.get(entry.direction);
                if (cohort) cohort.push(ret48);
                else ranks.set(entry.direction, [ret48]);
            }
            return ranks;
        });
        const cohort = cohorts.get(candidate.direction);
        if (!cohort || cohort.length < 2) return Number.NEGATIVE_INFINITY;
        return percentileRank(cohort, dirRet48);
    },
};
