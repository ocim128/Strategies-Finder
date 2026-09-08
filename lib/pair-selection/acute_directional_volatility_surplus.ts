import type { PairSelectionRule } from "./types";

export const acute_directional_volatility_surplus: PairSelectionRule = {
    key: "acute_directional_volatility_surplus",
    name: "Acute Directional Volatility Surplus",
    description: "Ranks the 12-bar favorable minus adverse directional volatility surplus.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_volatility_upside_rms_b12_r1",
                "feat_fp_volatility_downside_rms_b12_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/acute_directional_volatility_surplus.ts"],
    },
    score: (candidate) => {
        const up = candidate.feat_fp_volatility_upside_rms_b12_r1;
        const down = candidate.feat_fp_volatility_downside_rms_b12_r1;
        if (up === null || down === null) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? up - down : down - up;
    },
};
