import { directionAdjusted } from "./rule-helpers";
import type { PairSelectionRule } from "./types";

export const memory_decay_split: PairSelectionRule = {
    key: "memory_decay_split",
    name: "Memory Decay Split",
    description: "Weights directional 48-bar spread drift by the change in sign-follow-through between the two path halves.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_log_return_b48_r1"],
        },
        sourceFiles: [
            "lib/pair-selection/memory_decay_split.ts",
            "lib/pair-selection/rule-helpers.ts",
        ],
    },
    score: (candidate) => {
        const return48 = directionAdjusted(candidate, candidate.feat_fp_spread_log_return_b48_r1);
        const memoryTrend = candidate.feat_fp_spread_memory_trend_b48_r1;
        if (return48 === null || memoryTrend === null || !Number.isFinite(memoryTrend)) {
            return Number.NEGATIVE_INFINITY;
        }
        const weight = Math.min(1, Math.max(-1, memoryTrend));
        return return48 * weight;
    },
};
