import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface VisibilityRanks {
    base: ReadonlyMap<string, readonly number[]>;
    quote: ReadonlyMap<string, readonly number[]>;
}

function percentileRank(values: readonly number[], value: number): number | null {
    if (values.length === 0) return null;
    if (values.length === 1) return 1;
    let less = 0;
    let equal = 0;
    for (const entry of values) {
        if (entry < value) less += 1;
        else if (entry === value) equal += 1;
    }
    return (less + (equal - 1) / 2) / (values.length - 1);
}

function buildVisibilityRanks(pool: readonly PairCandidate[]): VisibilityRanks {
    const base = new Map<string, number[]>();
    const quote = new Map<string, number[]>();
    for (const entry of pool) {
        const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) continue;
        const baseValues = base.get(entry.baseSymbol) ?? [];
        baseValues.push(return48);
        base.set(entry.baseSymbol, baseValues);
        const quoteValues = quote.get(entry.quoteSymbol) ?? [];
        quoteValues.push(return48);
        quote.set(entry.quoteSymbol, quoteValues);
    }
    return { base, quote };
}

export const dual_visibility_percentile: PairSelectionRule = {
    key: "dual_visibility_percentile",
    name: "Dual Visibility Percentile",
    description: "Ranks by the weaker of the candidate's base- and quote-cohort directional momentum percentiles.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/dual_visibility_percentile.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const ranks = memoByPool(pool, "dual-visibility-percentile-ranks", () => buildVisibilityRanks(pool));
        const baseValues = ranks.base.get(candidate.baseSymbol);
        const quoteValues = ranks.quote.get(candidate.quoteSymbol);
        if (!baseValues || !quoteValues) return Number.NEGATIVE_INFINITY;
        const baseRank = percentileRank(baseValues, return48);
        const quoteRank = percentileRank(quoteValues, return48);
        return baseRank === null || quoteRank === null
            ? Number.NEGATIVE_INFINITY
            : Math.min(baseRank, quoteRank);
    },
};
