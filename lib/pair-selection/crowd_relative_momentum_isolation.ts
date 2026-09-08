import { medianValid, memoByPool } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const crowd_relative_momentum_isolation: PairSelectionRule = {
    key: "crowd_relative_momentum_isolation",
    name: "Crowd Relative Momentum Isolation",
    description: "Ranks directional 20-bar return excess over the raw event-median return.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/crowd_relative_momentum_isolation.ts"],
    },
    score: (candidate, _event, _params, pool) => {
        const ret = candidate.feat_return20;
        const med = memoByPool(pool, "crowd-ret20-med", () => medianValid(pool, (entry) => entry.feat_return20));
        if (ret === null || med === null) return Number.NEGATIVE_INFINITY;
        const excess = ret - med;
        return candidate.direction === "long" ? excess : -excess;
    },
};
