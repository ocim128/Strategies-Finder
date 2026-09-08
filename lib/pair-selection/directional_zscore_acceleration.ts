import type { PairSelectionRule } from "./types";

export const directional_zscore_acceleration: PairSelectionRule = {
    key: "directional_zscore_acceleration",
    name: "Directional Z-Score Acceleration",
    description: "Ranks the direction-aligned difference between 12-bar and 48-bar spread z-scores.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_zscore_b12_r1", "feat_fp_spread_zscore_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/directional_zscore_acceleration.ts"],
    },
    score: (candidate) => {
        const z12 = candidate.feat_fp_spread_zscore_b12_r1;
        const z48 = candidate.feat_fp_spread_zscore_b48_r1;
        if (z12 === null || z48 === null) return Number.NEGATIVE_INFINITY;
        const accel = z12 - z48;
        return candidate.direction === "long" ? accel : -accel;
    },
};
