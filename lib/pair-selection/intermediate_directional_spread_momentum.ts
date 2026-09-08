import type { PairSelectionRule } from "./types";

export const intermediate_directional_spread_momentum: PairSelectionRule = {
    key: "intermediate_directional_spread_momentum",
    name: "Intermediate Directional Spread Momentum",
    description: "Ranks unfiltered direction-aligned 48-bar spread log return.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_spread_log_return_b48_r1"] },
        sourceFiles: ["lib/pair-selection/intermediate_directional_spread_momentum.ts"],
    },
    score: (candidate) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        if (ret48 === null || !Number.isFinite(ret48)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? ret48 : -ret48;
    },
};
