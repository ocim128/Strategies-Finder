import type { PairSelectionRule } from "./types";

export const directional_sign_fraction: PairSelectionRule = {
    key: "directional_sign_fraction",
    name: "Directional Sign Fraction",
    description: "Ranks the fraction of positive direction-adjusted spread increments in the 48-bar path.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        sourceFiles: ["lib/pair-selection/directional_sign_fraction.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_sign_fraction_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
