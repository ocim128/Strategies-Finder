import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

function quantile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const position = percentile * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower]!;
    const weight = position - lower;
    return sorted[lower]! + weight * (sorted[upper]! - sorted[lower]!);
}

export const momentum_percentile_target: PairSelectionRule = {
    key: "momentum_percentile_target",
    name: "Momentum Percentile Target",
    description: "Selects the candidate closest to a target percentile of event directional momentum.",
    defaultParams: { targetPercentile: 0.8 },
    paramLabels: { targetPercentile: "Target percentile of the event momentum distribution" },
    normalizeParams: (params) => ({
        ...params,
        targetPercentile: Math.min(1, Math.max(0, params.targetPercentile!)),
    }),
    metadata: {
        paramBounds: { targetPercentile: { min: 0, max: 1, step: 0.01 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/momentum_percentile_target.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        if (return48 === null) return Number.NEGATIVE_INFINITY;
        const values = memoByPool(pool, "momentum-percentile-target-values", () => pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
            .filter((value): value is number => value !== null));
        const target = quantile(values, params.targetPercentile!);
        return target === null ? Number.NEGATIVE_INFINITY : -Math.abs(return48 - target);
    },
};
