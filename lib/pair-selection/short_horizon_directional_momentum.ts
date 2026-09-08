import type { PairSelectionRule } from "./types";

export const short_horizon_directional_momentum: PairSelectionRule = {
    key: "short_horizon_directional_momentum",
    name: "Short Horizon Directional Momentum",
    description: "Ranks direction-aligned 12-bar spread log return.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: { libraryRelease: "v2", columns: ["feat_fp_spread_log_return_b12_r1"] },
        sourceFiles: ["lib/pair-selection/short_horizon_directional_momentum.ts"],
    },
    score: (candidate) => {
        const ret12 = candidate.feat_fp_spread_log_return_b12_r1;
        if (ret12 === null || !Number.isFinite(ret12)) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? ret12 : -ret12;
    },
};
