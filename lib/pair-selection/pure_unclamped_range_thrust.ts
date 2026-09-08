import type { PairSelectionRule } from "./types";

export const pure_unclamped_range_thrust: PairSelectionRule = {
    key: "pure_unclamped_range_thrust",
    name: "Pure Unclamped Range Thrust",
    description: "Ranks direction-aligned unclamped entry-bar range position.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/pure_unclamped_range_thrust.ts"],
    },
    score: (candidate) => {
        const pos = candidate.feat_entryRangePosition;
        if (pos === null || !Number.isFinite(pos)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? pos : -pos;
    },
};
