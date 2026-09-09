import { directionAdjusted, median, memoByPool } from "./rule-helpers";
import type { PairCandidate, PairSelectionRule } from "./types";

interface EventHorizonMedians {
    return12: number | null;
    return240: number | null;
}

function eventHorizonMedians(pool: readonly PairCandidate[]): EventHorizonMedians {
    return {
        return12: median(pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b12_r1))
            .filter((value): value is number => value !== null)),
        return240: median(pool
            .map((entry) => directionAdjusted(entry, entry.feat_fp_spread_log_return_b240_r1))
            .filter((value): value is number => value !== null)),
    };
}

export const event_horizon_conflict_regime_switch: PairSelectionRule = {
    key: "event_horizon_conflict_regime_switch",
    name: "Event Horizon Conflict Regime Switch",
    description: "Uses momentum when event-median fast and slow return signs agree and ATR otherwise.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b12_r1",
                "feat_fp_spread_log_return_b240_r1",
                "feat_fp_spread_log_return_b48_r1",
            ],
        },
        sourceFiles: [
            "lib/pair-selection/event_horizon_conflict_regime_switch.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate, _event, _params, pool) => {
        const medians = memoByPool(pool, "event-horizon-conflict-regime-switch-medians", () => eventHorizonMedians(pool));
        const horizonsAgree = medians.return12 !== null
            && medians.return240 !== null
            && Math.sign(medians.return12) === Math.sign(medians.return240);
        if (horizonsAgree) {
            return directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1)
                ?? Number.NEGATIVE_INFINITY;
        }
        return candidate.feat_atrPct !== null && Number.isFinite(candidate.feat_atrPct)
            ? candidate.feat_atrPct
            : Number.NEGATIVE_INFINITY;
    },
};
