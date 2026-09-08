import type { PairSelectionRule } from "./types";

export const directional_volatility_asymmetry_ratio: PairSelectionRule = {
    key: "directional_volatility_asymmetry_ratio",
    name: "Directional Volatility Asymmetry Ratio",
    description: "Ranks favorable semi-deviation relative to adverse semi-deviation.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_volatility_upside_rms_b48_r1",
                "feat_fp_volatility_downside_rms_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_volatility_asymmetry_ratio.ts"],
    },
    score: (candidate) => {
        const upRms = candidate.feat_fp_volatility_upside_rms_b48_r1;
        const downRms = candidate.feat_fp_volatility_downside_rms_b48_r1;
        if (upRms === null || downRms === null || downRms <= 0 || upRms <= 0) return Number.NEGATIVE_INFINITY;
        return candidate.direction === "long" ? upRms / downRms : downRms / upRms;
    },
};
