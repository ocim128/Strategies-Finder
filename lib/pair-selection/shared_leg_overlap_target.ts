import { sharedLegOverlapFraction } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const shared_leg_overlap_target: PairSelectionRule = {
    key: "shared_leg_overlap_target",
    name: "SHARED_LEG_OVERLAP_TARGET",
    description: "Targets a chosen share of same-event peers sharing either spread leg.",
    defaultParams: { targetSharedLegOverlapFraction: 0 },
    paramLabels: { targetSharedLegOverlapFraction: "Target shared-leg overlap" },
    score: (candidate, _event, params, pool) => {
        const overlapFraction = sharedLegOverlapFraction(candidate, pool);
        if (overlapFraction === null) return Number.NEGATIVE_INFINITY;
        return -Math.abs(overlapFraction - params.targetSharedLegOverlapFraction!);
    },
};
