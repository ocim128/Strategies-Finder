import { sharedLegOverlapFraction } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const crowd_isolated_loudest_atr: PairSelectionRule = {
    key: "crowd_isolated_loudest_atr",
    name: "Crowd Isolated Loudest ATR",
    description: "Penalizes signal ATR percentage by same-event shared-leg overlap.",
    defaultParams: { crowdingPenalty: 0.8 },
    paramLabels: { crowdingPenalty: "Penalty factor applied to shared-leg overlap fraction in the same-event pool" },
    metadata: {
        sourceFiles: ["lib/pair-selection/crowd_isolated_loudest_atr.ts"],
    },
    score: (candidate, _event, params, pool) => {
        const atr = candidate.feat_atrPct;
        const overlap = sharedLegOverlapFraction(candidate, pool);
        if (atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        return atr * (1 - (overlap ?? 0) * params.crowdingPenalty!);
    },
};
