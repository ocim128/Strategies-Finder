import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

function normalizeExcludedFraction(value: number): number {
    return Math.min(0.5, Math.max(0, value));
}

function quantile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) return null;
    const position = percentile * (values.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return values[lower]!;
    const weight = position - lower;
    return values[lower]! + weight * (values[upper]! - values[lower]!);
}

export const tail_excluded_fnv_pick: PairSelectionRule = {
    key: "tail_excluded_fnv_pick",
    name: "Tail Excluded FNV Pick",
    description: "Selects the deterministic FNV winner from the middle of the event momentum distribution.",
    defaultParams: { excludedFraction: 0.1 },
    paramLabels: { excludedFraction: "Fraction trimmed from each momentum tail" },
    normalizeParams: (params) => ({
        ...params,
        excludedFraction: normalizeExcludedFraction(params.excludedFraction!),
    }),
    metadata: {
        paramBounds: { excludedFraction: { min: 0, max: 0.5, step: 0.01 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/tail_excluded_fnv_pick.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return 0;
        const values = memoByPool(pool, "tail-excluded-fnv-pick-momentum-values", () => pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
            .filter((value): value is number => value !== null)
            .sort((left, right) => left - right));
        const excludedFraction = normalizeExcludedFraction(params.excludedFraction!);
        const lower = quantile(values, excludedFraction);
        const upper = quantile(values, 1 - excludedFraction);
        return lower !== null && upper !== null && return48 > lower && return48 < upper ? 1 : 0;
    },
};
