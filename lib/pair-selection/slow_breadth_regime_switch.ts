import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const slow_breadth_regime_switch: PairSelectionRule = {
    key: "slow_breadth_regime_switch",
    name: "Slow Breadth Regime Switch",
    description: "Uses momentum when at least half the event pool has positive directional 240-bar returns and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b240_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/slow_breadth_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const positiveCount = memoByPool(pool, "slow-breadth-regime-switch-positive-count", () => pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b240_r1))
            .filter((value): value is number => value !== null && value > 0)
            .length);
        if (positiveCount >= pool.length / 2) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
