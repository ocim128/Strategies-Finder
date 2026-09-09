import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface ThemeTightnessStats {
    poolIqr: number;
    cohortIqrByBase: ReadonlyMap<string, number>;
}

function quantile(sorted: readonly number[], percentile: number): number | null {
    if (sorted.length === 0) return null;
    const position = percentile * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower]!;
    const weight = position - lower;
    return sorted[lower]! + weight * (sorted[upper]! - sorted[lower]!);
}

function interquartileRange(values: readonly number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    const lower = quantile(sorted, 0.25);
    const upper = quantile(sorted, 0.75);
    return lower === null || upper === null ? 0 : upper - lower;
}

function buildStats(pool: readonly PairCandidate[]): ThemeTightnessStats {
    const allValues: number[] = [];
    const byBase = new Map<string, number[]>();
    for (const entry of pool) {
        const value = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
        if (value === null) continue;
        allValues.push(value);
        const values = byBase.get(entry.baseSymbol) ?? [];
        values.push(value);
        byBase.set(entry.baseSymbol, values);
    }
    const cohortIqrByBase = new Map<string, number>();
    for (const [base, values] of byBase) cohortIqrByBase.set(base, interquartileRange(values));
    return { poolIqr: interquartileRange(allValues), cohortIqrByBase };
}

export const theme_tightness_weight: PairSelectionRule = {
    key: "theme_tightness_weight",
    name: "Theme Tightness Weight",
    description: "Weights directional spread momentum by the relative interquartile tightness of its base-symbol cohort.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/theme_tightness_weight.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const stats = memoByPool(pool, "theme-tightness-weight-stats", () => buildStats(pool));
        const cohortIqr = stats.cohortIqrByBase.get(candidate.baseSymbol);
        if (cohortIqr === undefined) return Number.NEGATIVE_INFINITY;
        const weight = stats.poolIqr === 0 ? 1 : Math.max(0, 1 - cohortIqr / stats.poolIqr);
        return return48 * weight;
    },
};
