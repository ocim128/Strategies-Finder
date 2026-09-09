import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface DirectionCounts {
    long: number;
    short: number;
}

function buildDirectionCounts(pool: readonly PairCandidate[]): ReadonlyMap<string, DirectionCounts> {
    const counts = new Map<string, DirectionCounts>();
    for (const entry of pool) {
        const current = counts.get(entry.baseSymbol) ?? { long: 0, short: 0 };
        if (entry.direction === "long") current.long += 1;
        else current.short += 1;
        counts.set(entry.baseSymbol, current);
    }
    return counts;
}

export const base_cohort_direction_purity_weight: PairSelectionRule = {
    key: "base_cohort_direction_purity_weight",
    name: "Base Cohort Direction Purity Weight",
    description: "Weights directional spread momentum by direction consensus within the candidate's base cohort.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/base_cohort_direction_purity_weight.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const counts = memoByPool(pool, "base-cohort-direction-purity-counts", () => buildDirectionCounts(pool));
        const cohort = counts.get(candidate.baseSymbol);
        if (!cohort) return Number.NEGATIVE_INFINITY;
        const sameDirection = candidate.direction === "long" ? cohort.long : cohort.short;
        const total = cohort.long + cohort.short;
        return total === 0 ? Number.NEGATIVE_INFINITY : return48 * Math.abs(2 * (sameDirection / total) - 1);
    },
};
