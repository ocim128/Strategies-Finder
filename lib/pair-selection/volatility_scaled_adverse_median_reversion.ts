import type { PairSelectionRule } from "./types";

export const volatility_scaled_adverse_median_reversion: PairSelectionRule = {
    key: "volatility_scaled_adverse_median_reversion",
    name: "Volatility Scaled Adverse Median Reversion",
    description: "Scales adverse median displacement by signal ATR percentage.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_distance_to_median_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/volatility_scaled_adverse_median_reversion.ts"],
    },
    score: (candidate) => {
        const distanceToMedian = candidate.feat_fp_spread_distance_to_median_b48_r1;
        const atr = candidate.feat_atrPct;
        if (distanceToMedian === null || atr === null || atr <= 0) return Number.NEGATIVE_INFINITY;
        const adverseDistance = candidate.direction === "long" ? -distanceToMedian : distanceToMedian;
        return adverseDistance * atr;
    },
};
