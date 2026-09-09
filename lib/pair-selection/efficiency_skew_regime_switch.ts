import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function efficiencySkewness(pool: readonly PairCandidate[]): number {
    const values = pool
        .map((entry) => entry.feat_fp_spread_efficiency_ratio_b48_r1)
        .filter((value): value is number => value !== null && Number.isFinite(value));
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    if (variance === 0) return 0;
    const standardDeviation = Math.sqrt(variance);
    return values.reduce((sum, value) => sum + ((value - mean) / standardDeviation) ** 3, 0) / values.length;
}

export const efficiency_skew_regime_switch: PairSelectionRule = {
    key: "efficiency_skew_regime_switch",
    name: "Efficiency Skew Regime Switch",
    description: "Uses directional momentum when event efficiency is positively skewed and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_efficiency_ratio_b48_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/efficiency_skew_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const useMomentum = memoByPool(pool, "efficiency-skew-regime-switch-skewness", () =>
            efficiencySkewness(pool)) > 0;
        if (useMomentum) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
