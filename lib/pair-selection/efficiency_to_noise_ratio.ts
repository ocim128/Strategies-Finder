import type { PairSelectionRule } from "./types";

export const efficiency_to_noise_ratio: PairSelectionRule = {
    key: "efficiency_to_noise_ratio",
    name: "Efficiency to Noise Ratio",
    description: "Ranks 48-bar spread efficiency divided by return volatility.",
    defaultParams: { volFloor: 0.005 },
    paramLabels: { volFloor: "Floor added to return standard deviation to prevent division by near-zero" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_spread_efficiency_ratio_b48_r1",
                "feat_fp_volatility_return_std_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/efficiency_to_noise_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const eff = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        const vol = candidate.feat_fp_volatility_return_std_b48_r1;
        if (eff === null || vol === null || vol <= 0) return Number.NEGATIVE_INFINITY;
        return eff / (vol + params.volFloor!);
    },
};
