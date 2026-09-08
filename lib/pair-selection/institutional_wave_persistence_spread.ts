import type { PairSelectionRule } from "./types";

export const institutional_wave_persistence_spread: PairSelectionRule = {
    key: "institutional_wave_persistence_spread",
    name: "Institutional Wave Persistence Spread",
    description: "Scales direction-aligned 48-bar return by the lag-4 versus lag-1 autocorrelation differential.",
    defaultParams: { waveDifferentialWeight: 1.0 },
    paramLabels: { waveDifferentialWeight: "Weight on lag-4 minus lag-1 return autocorrelation" },
    metadata: {
        featureRequirements: {
            libraryRelease: "v2",
            columns: [
                "feat_fp_spread_log_return_b48_r1",
                "feat_fp_dependence_return_acf_b48_l1_r1",
                "feat_fp_dependence_return_acf_b48_l4_r1",
            ],
        },
        sourceFiles: ["lib/pair-selection/institutional_wave_persistence_spread.ts"],
    },
    score: (candidate, _event, params) => {
        const ret48 = candidate.feat_fp_spread_log_return_b48_r1;
        const acf1 = candidate.feat_fp_dependence_return_acf_b48_l1_r1;
        const acf4 = candidate.feat_fp_dependence_return_acf_b48_l4_r1;
        if (ret48 === null || acf1 === null || acf4 === null) return Number.NEGATIVE_INFINITY;
        const directionalRet48 = candidate.direction === "long" ? ret48 : -ret48;
        return directionalRet48 * (1 + params.waveDifferentialWeight! * (acf4 - acf1));
    },
};
