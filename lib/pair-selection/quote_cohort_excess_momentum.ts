import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function cohortMedians(pool: readonly PairCandidate[]): ReadonlyMap<string, number> {
    const medians = new Map<string, number>();
    const values = new Map<string, number[]>();
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        const cohort = values.get(entry.quoteSymbol) ?? [];
        cohort.push(return48);
        values.set(entry.quoteSymbol, cohort);
    }
    for (const [symbol, cohort] of values) {
        const value = median(cohort);
        if (value !== null) medians.set(symbol, value);
    }
    return medians;
}

export const quote_cohort_excess_momentum: PairSelectionRule = {
    key: "quote_cohort_excess_momentum",
    name: "Quote Cohort Excess Momentum",
    description: "Ranks directional 48-bar momentum above the median of candidates sharing the quote leg.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/quote_cohort_excess_momentum.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const medians = memoByPool(pool, "quote-cohort-excess-momentum-medians", () => cohortMedians(pool));
        const cohortMedian = medians.get(candidate.quoteSymbol);
        return cohortMedian === undefined ? Number.NEGATIVE_INFINITY : return48 - cohortMedian;
    },
};
