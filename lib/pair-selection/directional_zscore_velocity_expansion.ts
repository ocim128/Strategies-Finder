import type { PairSelectionRule } from "./types";

export const directional_zscore_velocity_expansion: PairSelectionRule = {
    key: "directional_zscore_velocity_expansion",
    name: "Directional Z-Score Velocity Expansion",
    description: "Ranks direction-aligned 12-bar z-score expansion over its 48-bar baseline.",
    defaultParams: { intermediateZWeight: 0.5 },
    paramLabels: { intermediateZWeight: "Weight on 48-bar z-score subtracted from 12-bar z-score" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_zscore_b12_r1",
                "feat_fp_spread_zscore_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_zscore_velocity_expansion.ts"],
    },
    score: (candidate, _event, params) => {
        const zscore12 = candidate.feat_fp_spread_zscore_b12_r1;
        const zscore48 = candidate.feat_fp_spread_zscore_b48_r1;
        if (zscore12 === null || zscore48 === null) return Number.NEGATIVE_INFINITY;
        const sign = candidate.direction === "long" ? 1 : -1;
        return sign * (zscore12 - params.intermediateZWeight! * zscore48);
    },
};
