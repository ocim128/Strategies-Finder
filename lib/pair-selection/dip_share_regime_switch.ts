import { directionAdjusted, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const dip_share_regime_switch: PairSelectionRule = {
    key: "dip_share_regime_switch",
    name: "Dip Share Regime Switch",
    description: "Uses momentum when at most one third of the event pool is in a 12-bar pullback within a positive 48-bar trend.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/dip_share_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const dipCount = memoByPool(pool, "dip-share-regime-switch-count", () => pool.filter((entry) => {
            const return12 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1);
            const return48 = directionAdjusted(entry, entry.feat_fp_spread_log_return_b48_r1);
            return return12 !== null && return48 !== null && return12 < 0 && return48 > 0;
        }).length);
        if (pool.length > 0 && dipCount / pool.length <= 1 / 3) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
