import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

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

function buildScores(pool: readonly PairCandidate[]): ReadonlyMap<PairCandidate, number> {
    const values = pool
        .map((candidate) => ({
            candidate,
            return48: directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1),
        }))
        .filter((value): value is { candidate: PairCandidate; return48: number } => value.return48 !== null)
        .sort((left, right) => right.return48 - left.return48);
    const returns = values.map((value) => value.return48);
    const percentiles = values.map((value) => percentileRank(returns, value.return48));
    const scores = new Map<PairCandidate, number>();
    for (let index = 0; index < values.length; index += 1) {
        let total = percentiles[index]!;
        let count = 1;
        if (index > 0) {
            total += percentiles[index - 1]!;
            count += 1;
        }
        if (index + 1 < percentiles.length) {
            total += percentiles[index + 1]!;
            count += 1;
        }
        scores.set(values[index]!.candidate, total / count);
    }
    return scores;
}

export const rank_neighborhood_smoothed_pick: PairSelectionRule = {
    key: "rank_neighborhood_smoothed_pick",
    name: "Rank Neighborhood Smoothed Pick",
    description: "Ranks each candidate by the mean momentum percentile of itself and its adjacent event-ranking neighbors.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/rank_neighborhood_smoothed_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        if (candidate.feat_fp_spread_log_return_b48_r1 === null) return Number.NEGATIVE_INFINITY;
        return memoByPool(pool, "rank-neighborhood-smoothed-pick-scores", () => buildScores(pool))
            .get(candidate) ?? Number.NEGATIVE_INFINITY;
    },
};
