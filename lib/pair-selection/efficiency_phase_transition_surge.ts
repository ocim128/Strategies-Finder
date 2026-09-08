import type { PairSelectionRule } from "./types";

export const efficiency_phase_transition_surge: PairSelectionRule = {
    key: "efficiency_phase_transition_surge",
    name: "Efficiency Phase Transition Surge",
    description: "Ranks the increase from 48-bar to 12-bar spread efficiency.",
    defaultParams: {},
    paramLabels: {},
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_efficiency_ratio_b12_r1",
                "feat_fp_spread_efficiency_ratio_b48_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/efficiency_phase_transition_surge.ts"],
    },
    score: (candidate) => {
        const eff12 = candidate.feat_fp_spread_efficiency_ratio_b12_r1;
        const eff48 = candidate.feat_fp_spread_efficiency_ratio_b48_r1;
        if (eff12 === null || eff48 === null) return Number.NEGATIVE_INFINITY;
        return eff12 - eff48;
    },
};
