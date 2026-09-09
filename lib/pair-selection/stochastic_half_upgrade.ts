import type { PairSelectionRule } from "./types";

export const stochastic_half_upgrade: PairSelectionRule = {
    key: "stochastic_half_upgrade",
    name: "Stochastic Half Upgrade",
    description: "Ranks the normalized Mann-Whitney upgrade of late directional spread increments over early increments.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: ["feat_fp_spread_half_upgrade_u_b48_r1"],
        },
        sourceFiles: ["lib/pair-selection/stochastic_half_upgrade.ts"],
    },
    score: (candidate) => candidate.feat_fp_spread_half_upgrade_u_b48_r1
        ?? Number.NEGATIVE_INFINITY,
};
