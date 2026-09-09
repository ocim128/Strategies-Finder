import type { PairSelectionRule } from "./types";

export const bars_since_directional_extreme: PairSelectionRule = {
    key: "bars_since_directional_extreme",
    name: "Bars Since Directional Extreme",
    description: "Prefers candidates whose direction-adjusted 48-bar path most recently printed its running maximum.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_bars_since_extreme_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/bars_since_directional_extreme.ts"],
    },
    score: (candidate) => {
        const bars = candidate.feat_fp_spread_bars_since_extreme_b48_r1;
        return bars === null ? Number.NEGATIVE_INFINITY : -bars;
    },
};
