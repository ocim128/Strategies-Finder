import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function poolStandardDeviation(pool: readonly PairCandidate[]): number | null {
    const values = pool
        .map((entry) => entry.feat_fp_spread_log_return_b48_r1)
        .filter((value): value is number => value !== null && Number.isFinite(value));
    if (values.length === 0) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

export const dispersion_conditioned_horizon_switch: PairSelectionRule = {
    key: "dispersion_conditioned_horizon_switch",
    name: "Dispersion Conditioned Horizon Switch",
    description: "Weights direction-aligned intermediate momentum by event-level return dispersion.",
    defaultParams: { dispersionWeight: 10.0 },
    paramLabels: { dispersionWeight: "Sensitivity weight scaling 48-bar return by pool dispersion" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/dispersion_conditioned_horizon_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        if (ret12 === null || ret48 === null) return Number.NEGATIVE_INFINITY;
        const dispersion = memoByPool(pool, "dispersion-conditioned-horizon-switch", () => poolStandardDeviation(pool));
        if (dispersion === null) return Number.NEGATIVE_INFINITY;
        const directionalRet12 = directionAdjusted(candidate, ret12);
        const directionalRet48 = directionAdjusted(candidate, ret48);
        if (directionalRet12 === null || directionalRet48 === null) return Number.NEGATIVE_INFINITY;
        return directionalRet12 + params.dispersionWeight! * dispersion * directionalRet48;
    },
};
