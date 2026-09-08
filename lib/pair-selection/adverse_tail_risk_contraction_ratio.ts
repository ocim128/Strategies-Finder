import type { PairSelectionRule } from "./types";

export const adverse_tail_risk_contraction_ratio: PairSelectionRule = {
    key: "adverse_tail_risk_contraction_ratio",
    name: "Adverse Tail Risk Contraction Ratio",
    description: "Minimizes short-term directional adverse RMS relative to its 240-bar baseline.",
    defaultParams: { volFloor: 0.001 },
    paramLabels: { volFloor: "Floor added to baseline 240-bar adverse RMS" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v1",
            columns: [
                "feat_fp_volatility_downside_rms_b12_r1",
                "feat_fp_volatility_downside_rms_b240_r1",
                "feat_fp_volatility_upside_rms_b12_r1",
                "feat_fp_volatility_upside_rms_b240_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/adverse_tail_risk_contraction_ratio.ts"],
    },
    score: (candidate, _event, params) => {
        const shortAdv = candidate.direction === "long"
            ? candidate.feat_fp_volatility_downside_rms_b12_r1
            : candidate.feat_fp_volatility_upside_rms_b12_r1;
        const longAdv = candidate.direction === "long"
            ? candidate.feat_fp_volatility_downside_rms_b240_r1
            : candidate.feat_fp_volatility_upside_rms_b240_r1;
        if (shortAdv === null || longAdv === null || longAdv <= 0) return Number.NEGATIVE_INFINITY;
        return -(shortAdv / (longAdv + params.volFloor!));
    },
};
