import type { PairSelectionRule } from "./types";

export const directional_volatility_skew: PairSelectionRule = {
    key: "directional_volatility_skew",
    name: "Directional Volatility Skew",
    description: "Ranks favorable versus adverse 48-bar spread return volatility in the signal direction.",
    defaultParams: { adverseFloor: 0.001 },
    paramLabels: { adverseFloor: "Floor added to adverse RMS to stabilize division against near-zero values" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_volatility_upside_rms_b48_r1",
                "feat_fp_volatility_downside_rms_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/directional_volatility_skew.ts"],
    },
    score: (candidate, _event, params) => {
        const fav = candidate.direction === "long"
            ? candidate.feat_fp_volatility_upside_rms_b48_r1
            : candidate.feat_fp_volatility_downside_rms_b48_r1;
        const adv = candidate.direction === "long"
            ? candidate.feat_fp_volatility_downside_rms_b48_r1
            : candidate.feat_fp_volatility_upside_rms_b48_r1;
        if (fav === null || adv === null || fav <= 0) return Number.NEGATIVE_INFINITY;
        return fav / (adv + params.adverseFloor!);
    },
};
