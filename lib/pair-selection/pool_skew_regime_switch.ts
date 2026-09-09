import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

function poolSkewness(pool: readonly PairCandidate[]): number {
    const values = pool
        .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1))
        .filter((value): value is number => value !== null);
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    if (variance === 0) return 0;
    const standardDeviation = Math.sqrt(variance);
    return values.reduce((sum, value) => sum + ((value - mean) / standardDeviation) ** 3, 0) / values.length;
}

export const pool_skew_regime_switch: PairSelectionRule = {
    key: "pool_skew_regime_switch",
    name: "Pool Skew Regime Switch",
    description: "Uses ATR for positive-skew momentum pools and directional momentum otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/pool_skew_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const useAtr = memoByPool(pool, "pool-skew-regime-switch-skewness", () => poolSkewness(pool)) > 0;
        if (useAtr) {
            return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
                ? candidate.feat_atrPct
                : Number.NEGATIVE_INFINITY;
        }
        return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
            ?? Number.NEGATIVE_INFINITY;
    },
};
