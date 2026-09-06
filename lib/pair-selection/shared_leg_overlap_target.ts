import { hasCanonicalPairIdentity } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const shared_leg_overlap_target: PairSelectionRule = {
    key: "shared_leg_overlap_target",
    name: "SHARED_LEG_OVERLAP_TARGET",
    description: "Targets a chosen share of same-event peers sharing either spread leg.",
    defaultParams: { targetSharedLegOverlapFraction: 0 },
    paramLabels: { targetSharedLegOverlapFraction: "Target shared-leg overlap" },
    score: (candidate, _event, params, pool) => {
        if (!hasCanonicalPairIdentity(candidate)) return Number.NEGATIVE_INFINITY;
        const others = pool.filter((entry) => entry !== candidate);
        if (others.length === 0 || others.some((entry) => !hasCanonicalPairIdentity(entry))) {
            return Number.NEGATIVE_INFINITY;
        }
        const sharedCount = others.filter((entry) =>
            entry.baseSymbol === candidate.baseSymbol
            || entry.baseSymbol === candidate.quoteSymbol
            || entry.quoteSymbol === candidate.baseSymbol
            || entry.quoteSymbol === candidate.quoteSymbol,
        ).length;
        const overlapFraction = sharedCount / others.length;
        if (!Number.isFinite(overlapFraction)) return Number.NEGATIVE_INFINITY;
        return -Math.abs(overlapFraction - params.targetSharedLegOverlapFraction!);
    },
};
