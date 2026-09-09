import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const persistence_regime_switch: PairSelectionRule = {
    key: "persistence_regime_switch",
    name: "Persistence Regime Switch",
    description: "Uses directional momentum when event-level autocorrelation is sufficiently streaky and ATR otherwise.",
    defaultParams: { minStreakiness: 0.1 },
    paramLabels: { minStreakiness: "Minimum event median absolute lag-1 autocorrelation" },
    metadata: {
        paramBounds: { minStreakiness: { min: 0, max: 1, step: 0.01 } },
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_dependence_return_acf_b48_l1_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/persistence_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, params, pool) => {
        const medianAbsoluteAutocorrelation = memoByPool(pool, "persistence-regime-switch-median-absolute-acf", () =>
            median(pool
                .map((entry) => entry.feat_fp_dependence_return_acf_b48_l1_r1)
                .filter((value): value is number => value !== null && Number.isFinite(value))
                .map((value) => Math.abs(value))));
        if (medianAbsoluteAutocorrelation !== null && medianAbsoluteAutocorrelation >= params.minStreakiness!) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
