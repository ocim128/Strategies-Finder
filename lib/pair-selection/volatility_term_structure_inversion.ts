import type { PairSelectionRule } from "./types";

export const volatility_term_structure_inversion: PairSelectionRule = {
    key: "volatility_term_structure_inversion",
    name: "Volatility Term Structure Inversion",
    description: "Ranks acute 12-bar spread volatility relative to its 48-bar baseline.",
    defaultParams: { volFloor: 0.001 },
    paramLabels: { volFloor: "Floor added to 48-bar volatility to stabilize division against near-zero values" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_volatility_return_std_b12_r1",
                "feat_fp_volatility_return_std_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/volatility_term_structure_inversion.ts"],
    },
    score: (candidate, _event, params) => {
        const shortVol = candidate.feat_fp_volatility_return_std_b12_r1;
        const medVol = candidate.feat_fp_volatility_return_std_b48_r1;
        if (shortVol === null || medVol === null || medVol <= 0) return Number.NEGATIVE_INFINITY;
        return shortVol / (medVol + params.volFloor!);
    },
};
