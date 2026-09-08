import type { PairSelectionRule } from "./types";

export const micro_macro_autocorrelation_divergence: PairSelectionRule = {
    key: "micro_macro_autocorrelation_divergence",
    name: "Micro Macro Autocorrelation Divergence",
    description: "Ranks 48-bar lag-4 return autocorrelation minus lag-1 autocorrelation.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_dependence_return_acf_b48_l4_r1",
                "feat_fp_dependence_return_acf_b48_l1_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/micro_macro_autocorrelation_divergence.ts"],
    },
    score: (candidate) => {
        const acf4 = candidate.feat_fp_dependence_return_acf_b48_l4_r1;
        const acf1 = candidate.feat_fp_dependence_return_acf_b48_l1_r1;
        if (acf4 === null || acf1 === null) return Number.NEGATIVE_INFINITY;
        return acf4 - acf1;
    },
};
