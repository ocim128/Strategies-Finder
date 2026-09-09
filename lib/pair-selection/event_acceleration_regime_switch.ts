import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface EventSlopeMedians {
    slope12: number | null;
    slope48: number | null;
}

function eventSlopeMedians(pool: readonly PairCandidate[]): EventSlopeMedians {
    return {
        slope12: median(pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b12_r2))
            .filter((value): value is number => value !== null)),
        slope48: median(pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_ols_slope_b48_r2))
            .filter((value): value is number => value !== null)),
    };
}

export const event_acceleration_regime_switch: PairSelectionRule = {
    key: "event_acceleration_regime_switch",
    name: "Event Acceleration Regime Switch",
    description: "Uses momentum when event-median short slope is at least event-median long slope and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_ols_slope_b12_r2",
                "feat_fp_spread_ols_slope_b48_r2",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/event_acceleration_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const medians = memoByPool(pool, "event-acceleration-regime-switch-medians", () => eventSlopeMedians(pool));
        if (medians.slope12 !== null && medians.slope48 !== null && medians.slope12 >= medians.slope48) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
